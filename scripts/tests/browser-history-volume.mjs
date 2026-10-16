import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { rpc } from './database-fixture.mjs'

// Chrome y PostgreSQL desechable: ninguna solicitud ni escritura sale a Supabase.
const output = 'output/revision-entrega-final/historial-voluminoso'
const baseUrl = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const page = await context.newPage()
page.setDefaultTimeout(20000)
const fixture = await browserDatabase(page)
const { db, today } = fixture
const errors = []
const reads = []
const transport = []
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.pathname === '/rest/v1/documents')
    reads.push(Object.fromEntries(url.searchParams))
})
page.on('response', async (response) => {
  if (new URL(response.url()).pathname !== '/rest/v1/documents') return
  const headers = await response.allHeaders()
  transport.push({
    prefer: response.request().headers().prefer,
    range: headers['content-range'],
    expose: headers['access-control-expose-headers'],
  })
})
const dateOffset = (day, offset) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + offset * 86400000)
    .toISOString()
    .slice(0, 10)
const yesterday = dateOffset(today, -1)
const monthFrom = `${today.slice(0, 8)}01`
const inMonth = yesterday >= monthFrom
const expectedMonth = inMonth ? 1205 : 805
const clock = (day, index) =>
  db.query("select set_config('lcp.test_now',$1,false)", [
    new Date(
      new Date(`${day}T14:00:00Z`).getTime() + Math.floor(index / 5) * 100000,
    ).toISOString(),
  ])
async function open(day, openingNio) {
  await clock(day, 0)
  return rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: day,
    openingNio,
    openingUsd: 0,
  })
}
async function issue(day, count, from = 0) {
  const customer = (
    await db.query('select id from public.customers order by id limit 1')
  ).rows[0].id
  for (let index = 0; index < count; index++) {
    await clock(day, index + from)
    await rpc(db, 'create_document', {
      requestId: crypto.randomUUID(),
      kind: 'invoice',
      customerId: customer,
      tier: 'emprendedor',
      currency: 'NIO',
      exchangeRate: 1,
      location: 'store',
      paymentMethod: 'cash',
      notes: '',
      items: [
        {
          productId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(((index + from) % 260) + 1).padStart(12, '0')}`,
          quantity: 1,
        },
      ],
    })
  }
}
try {
  await db.exec('reset role')
  await clock(yesterday, 0)
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  // Cantidad inicial de la fixture de historial; la simulación contable grande
  // comprueba por separado la conciliación del valor de los saldos de apertura.
  await db.exec(
    'reset role; update public.inventory_balances set quantity=1000',
  )
  await db.exec('set role authenticated')
  await open(yesterday, 1000)
  await issue(yesterday, 400)
  const priorDay = (await db.query('select public.get_business_day(null) r'))
    .rows[0].r
  await rpc(db, 'close_business_day', {
    requestId: crypto.randomUUID(),
    day: yesterday,
    countedNio: priorDay.report.expectedNio,
    countedUsd: 0,
    note: '',
    expectedRevision: priorDay.revision,
    expectedStateToken: priorDay.stateToken,
  })
  await open(today, priorDay.report.expectedNio)
  await issue(today, 805)
  equal(
    (await db.query('select count(*)::int n from public.documents')).rows[0].n,
    1205,
    '1205 facturas emitidas por la función real',
  )
  const expected = (
    await db.query(
      "select id,number from public.documents where created_at >= ($1::date::timestamp at time zone 'America/Managua') and created_at < (($2::date+1)::timestamp at time zone 'America/Managua') order by created_at desc,id desc",
      [monthFrom, today],
    )
  ).rows
  equal(expected.length, expectedMonth, 'período mensual conocido')
  await page.goto(`${baseUrl}/login`)
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
  await page.evaluate(() => {
    globalThis.history.pushState({}, '', '/sales/history')
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
  })
  await page
    .getByRole('heading', { name: 'Facturas emitidas', exact: true })
    .waitFor()
  const cards = page.locator('.record-card h2')
  await cards.nth(99).waitFor()
  equal(await cards.count(), 100, 'primera página de cien facturas')
  equal(
    await page.locator('.directory-count').innerText(),
    `100 de ${new Intl.NumberFormat('es-NI').format(expectedMonth)} facturas del período`,
    'el contador HTTP exacto debe llegar al navegador y habilitar más páginas',
  )
  equal(
    await cards.allTextContents(),
    expected.slice(0, 100).map((row) => row.number),
    'primeros cien con orden estable entre fechas iguales',
  )
  while ((await cards.count()) < expectedMonth) {
    const before = await cards.count()
    await page.getByRole('button', { name: /^Cargar más/ }).click()
    await page.waitForFunction(
      (count) =>
        globalThis.document.querySelectorAll('.record-card h2').length > count,
      before,
    )
  }
  const allNumbers = await cards.allTextContents()
  equal(
    allNumbers,
    expected.map((row) => row.number),
    'todas las páginas sin documentos perdidos ni duplicados',
  )
  equal(
    new Set(allNumbers).size,
    expectedMonth,
    'cada factura aparece una sola vez',
  )
  equal(
    await page.getByRole('button', { name: /^Cargar más/ }).count(),
    0,
    'no ofrece página inexistente al terminar',
  )
  await page.screenshot({ path: `${output}/historial-1205.png` })
  const initialExportRead = reads.length
  const exported = await page.evaluate(
    async (range) => {
      const { supabaseAdapter } =
        await import('/src/services/adapters/supabase.ts')
      const rows = await supabaseAdapter.exportDocuments('invoice', range)
      return rows.map((row) => ({ id: row.id, number: row.number }))
    },
    { from: yesterday, to: today },
  )
  equal(
    exported.length,
    1205,
    'exportación obtiene las1205facturas de ambos días',
  )
  equal(
    new Set(exported.map((row) => row.id)).size,
    1205,
    'exportación sin duplicados',
  )
  const exportReads = reads.slice(initialExportRead)
  equal(
    exportReads.map((read) => [read.offset ?? '0', read.limit]),
    [
      ['0', '1'],
      ['0', '500'],
      ['500', '500'],
      ['1000', '500'],
    ],
    'exportación usa conteo y tres páginas reales',
  )
  await page.getByRole('button', { name: 'Hoy', exact: true }).click()
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('.directory-count')
      ?.textContent?.includes('805'),
  )
  equal(
    await cards.count(),
    100,
    'cambiar período descarta las páginas anteriores',
  )
  const todayRows = (
    await db.query(
      "select number from public.documents where (created_at at time zone 'America/Managua')::date=$1 order by created_at desc,id desc limit 100",
      [today],
    )
  ).rows
  equal(
    await cards.allTextContents(),
    todayRows.map((row) => row.number),
    'Hoy incluye únicamente las facturas correctas',
  )
  await page.getByLabel('Desde', { exact: true }).fill(yesterday)
  await page.getByLabel('Hasta', { exact: true }).fill(yesterday)
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('.directory-count')
      ?.textContent?.includes('400'),
  )
  equal(await cards.count(), 100, 'rango manual de ayer reinicia la página')
  const priorRows = (
    await db.query(
      "select number from public.documents where (created_at at time zone 'America/Managua')::date=$1 order by created_at desc,id desc limit 100",
      [yesterday],
    )
  ).rows
  equal(
    await cards.allTextContents(),
    priorRows.map((row) => row.number),
    'rango manual respeta día Managua',
  )
  await page.getByRole('button', { name: 'Este mes', exact: true }).click()
  await cards.nth(99).waitFor()
  await issue(today, 796, 805)
  equal(
    (await db.query('select count(*)::int n from public.documents')).rows[0].n,
    2001,
    '2001 facturas preparadas para validar el límite',
  )
  const overLimitStart = reads.length
  const refusal = await page.evaluate(
    async (range) => {
      const { supabaseAdapter } =
        await import('/src/services/adapters/supabase.ts')
      try {
        await supabaseAdapter.exportDocuments('invoice', range)
        return null
      } catch (error) {
        return { kind: error.kind, message: error.message }
      }
    },
    { from: yesterday, to: today },
  )
  equal(
    refusal?.kind,
    'validation',
    'el límite de PDF produce validación comprensible',
  )
  assert.match(refusal.message, /2[,.]001.*2[,.]000/)
  checks++
  equal(
    reads.slice(overLimitStart).map((read) => [read.offset ?? '0', read.limit]),
    [['0', '1']],
    'másde2000se rechaza con un solo conteo antes de descargar documentos',
  )
  await page.getByLabel('Desde', { exact: true }).fill(yesterday)
  await page.getByLabel('Hasta', { exact: true }).fill(today)
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('.directory-count')
      ?.textContent?.includes('2,001'),
  )
  const downloads = []
  page.on('download', (download) =>
    downloads.push(download.suggestedFilename()),
  )
  const uiExportStart = reads.length
  await page
    .getByRole('button', { name: 'Exportar PDF del período', exact: true })
    .click()
  await page
    .getByRole('alert')
    .filter({ hasText: /PDF admite hasta/ })
    .waitFor()
  equal(
    downloads,
    [],
    'la pantalla no descarga un PDF incompleto al superar el límite',
  )
  equal(
    reads.slice(uiExportStart).map((read) => [read.offset ?? '0', read.limit]),
    [['0', '1']],
    'el botón de exportar también se detiene tras el conteo',
  )
  await page.screenshot({ path: `${output}/limite-exportacion-2001.png` })
  equal(errors, [], 'Chrome sin errores de ejecución')
  equal(
    fixture.failures,
    [],
    'todas las lecturas y escrituras de la API local son válidas',
  )
  equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth >
        globalThis.innerWidth + 1,
    ),
    false,
    'historial sin desbordamiento horizontal',
  )
  const summary = {
    isolated: true,
    initialInvoices: 1205,
    limitInvoices: 2001,
    pageSize: 100,
    exportPageSize: 500,
    duplicateTimestamps: true,
    todayInvoices: 805,
    yesterdayInvoices: 400,
    assertions: checks,
    errors,
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2))
  console.log(
    `PASS historial voluminoso: ${checks} verificaciones;1205 facturas sin pérdidas/duplicados;Hoy805/ayer400;exportación500+500+205;rechazo2001conunconteo`,
  )
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  console.error(
    'Estado visible:',
    await page
      .locator('.directory-count')
      .textContent()
      .catch(() => null),
    'Lecturas:',
    JSON.stringify(reads.slice(-3)),
    'Transporte:',
    JSON.stringify(transport.slice(-3)),
  )
  console.error(`FAIL historial voluminoso: ${error.stack}`)
  process.exitCode = 1
} finally {
  await fixture.close()
  await context.close()
  await browser.close()
}
