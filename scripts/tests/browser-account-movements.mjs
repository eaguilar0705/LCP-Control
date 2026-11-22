import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity, rpc } from './database-fixture.mjs'

const base = 'http://127.0.0.1:5221'
const server = await createServer({
  configFile: 'frontend/vite.config.ts',
  server: { host: '127.0.0.1', port: 5221, strictPort: true },
})
const bank = '1120-001'
const otherBank = '1120-003'
const emptyAccount = '1120-005'
const pendingCards = '1142'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const expense = 'Pago de publicidad desde BAC'
const previousExpense = 'Pago de publicidad del día anterior'
const voidedExpense = 'Egreso bancario anulado'
const money = new Intl.NumberFormat('es-NI', {
  style: 'currency',
  currency: 'NIO',
  currencyDisplay: 'code',
})
const normalize = (text) => text.replaceAll('\u00a0', ' ')
const amount = (value) => normalize(money.format(value))

async function seedMovements({ db, today }) {
  const previousDay = (
    await db.query('select ($1::date - 1)::text as previous_day', [today])
  ).rows[0].previous_day
  const initial = (await db.query('select public.get_opening_journal_id() id'))
    .rows[0].id
  await rpc(db, 'correct_opening_journal', {
    requestId: crypto.randomUUID(),
    entryId: initial,
    expectedRevision: 0,
    description: 'Apertura de auditoría',
    reference: 'QA',
    lines: [
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: bank, debit: 500, credit: 0 },
      { account: '1130', debit: 780000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 781500 },
    ],
  })
  await db.exec('reset role')
  await db.query(
    'update public.journal_entries set occurred_on=$1 where id=$2',
    [previousDay, initial],
  )
  await identity(db, admin)
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 1000,
    openingUsd: 0,
    note: '',
  })
  function sell(paymentMethod, quantity) {
    return rpc(db, 'create_document', {
      requestId: crypto.randomUUID(),
      kind: 'invoice',
      customerName: 'Cliente de prueba',
      tier: 'emprendedor',
      currency: 'NIO',
      exchangeRate: 1,
      location: 'store',
      paymentMethod,
      notes: '',
      items: [{ productId: product, quantity }],
    })
  }
  const first = await sell('bac_nio', 1)
  const second = await sell('bac_nio', 2)
  const other = await sell('lafise_nio', 1)
  const card = await sell('card_pos', 1)
  function postExpense(description, reference, amount, occurredOn = today) {
    return rpc(db, 'record_journal_entry', {
      requestId: crypto.randomUUID(),
      kind: 'expense',
      occurredOn,
      description,
      reference,
      currency: 'NIO',
      exchangeRate: 1,
      lines: [
        { account: '5130-008', debit: amount, credit: 0 },
        { account: bank, debit: 0, credit: amount },
      ],
    })
  }
  await postExpense(previousExpense, 'QA-ANTERIOR', 50, previousDay)
  await postExpense(expense, 'QA-PUBLICIDAD', 125)
  const voided = await postExpense(voidedExpense, 'QA-ANULADO', 201)
  await db.query('select public.void_journal_entry($1, $2)', [
    voided,
    'El egreso no se realizó',
  ])
  return { first, second, other, card, previousDay }
}

async function login(page) {
  await page.goto(base + '/login')
  await page
    .getByLabel('Correo electrónico', { exact: true })
    .fill('auditoria@example.test')
  await page
    .getByLabel('Contraseña', { exact: true })
    .fill('Local-test-password!')
  await page
    .getByRole('button', { name: 'Iniciar sesión', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
}

await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 950 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    try {
      const { first, second, other, card, previousDay } =
        await seedMovements(fixture)
      await login(page)
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/accounting')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('button', { name: 'Movimientos por cuenta', exact: true })
        .click()
      const selector = page.getByLabel('Cuenta contable', { exact: true })
      const from = page.getByLabel('Desde', { exact: true })
      const to = page.getByLabel('Hasta', { exact: true })
      const summary = async (label, value) =>
        assert.equal(
          normalize(
            await page
              .getByText(label, { exact: true })
              .locator('..')
              .locator('dd')
              .innerText(),
          ),
          amount(value),
        )
      assert.equal(await from.inputValue(), '')
      assert.match(
        await selector.locator(`option[value="${bank}"]`).innerText(),
        /^1120-001 · BAC C\$$/,
      )
      await selector.selectOption(bank)
      const expenses = page.getByRole('row').filter({ hasText: expense })
      const previous = page
        .getByRole('row')
        .filter({ hasText: previousExpense })
      await expenses.waitFor()
      await previous.waitFor()
      for (const label of [
        'Fecha',
        'Origen',
        'Referencia',
        'Concepto',
        'Debe',
        'Haber',
        'Saldo',
      ]) {
        assert.equal(
          await page
            .getByRole('columnheader', { name: label, exact: true })
            .count(),
          1,
        )
      }
      assert.match(await expenses.innerText(), /egreso/i)
      assert.match(await expenses.innerText(), /QA-PUBLICIDAD/)
      assert.equal(
        await expenses.locator('time').getAttribute('datetime'),
        fixture.today,
      )
      assert.equal(
        await previous.locator('time').getAttribute('datetime'),
        previousDay,
      )
      assert.equal(
        normalize(await expenses.getByRole('cell').nth(5).innerText()),
        amount(125),
      )
      await summary('Saldo inicial', 500)
      await summary('Saldo final', 1423)
      assert.equal(
        await page.getByText(voidedExpense, { exact: true }).count(),
        0,
      )
      assert.equal(
        await page.getByRole('row').filter({ hasText: other.number }).count(),
        0,
      )
      const cardSale = page.getByRole('row').filter({ hasText: card.number })
      assert.equal(await cardSale.count(), 0)
      for (const document of [first, second]) {
        const sale = page.getByRole('row').filter({ hasText: document.number })
        await sale.waitFor()
        assert.match(await sale.innerText(), /venta|factura/i)
        assert.equal(
          normalize(await sale.getByRole('cell').nth(4).innerText()),
          amount(document.total),
        )
      }
      await selector.selectOption(otherBank)
      await page.getByRole('row').filter({ hasText: other.number }).waitFor()
      assert.equal(await expenses.count(), 0)
      assert.equal(await cardSale.count(), 0)

      await selector.selectOption(pendingCards)
      await cardSale.waitFor()
      assert.equal(
        normalize(await cardSale.getByRole('cell').nth(4).innerText()),
        amount(card.total),
      )
      await summary('Saldo final', card.total)

      await selector.selectOption(emptyAccount)
      await page
        .getByText('Sin movimientos en este período.', { exact: true })
        .waitFor()
      await selector.selectOption(bank)
      await expenses.waitFor()

      await from.fill(fixture.today)
      await previous.waitFor({ state: 'hidden' })
      await expenses.waitFor()
      await summary('Saldo inicial', 450)
      await from.fill('')
      await previous.waitFor()
      await to.fill(previousDay)
      await expenses.waitFor({ state: 'hidden' })
      await previous.waitFor()
      await summary('Saldo final', 450)
      assert.equal(await selector.inputValue(), bank)
      await page.getByRole('button', { name: 'Todo el historial' }).click()
      await expenses.waitFor()
      await summary('Saldo final', 1423)

      assert.deepEqual(errors, [])
      assert.deepEqual(fixture.failures, [])
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'la página no se desborda en pantallas pequeñas',
      )
      console.log(`PASS movimientos aislados por cuenta y fecha en ${width}px`)
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
