// Datos de prueba por las pantallas: la dueña registra un cliente, un
// proveedor y un perfume, cuenta existencias, ventas emite una factura, y
// después se borra todo desde el programa. En cada paso se comprueba en la
// base lo que la pantalla dice que hizo. Al final se compara la huella de todas
// las tablas con la de antes de empezar.
//
//   node tests/audit/ui-roundtrip.mjs
//
// Base desechable y API de Supabase simulada; no toca la base real.
import { mkdirSync } from 'node:fs'
import { startAudit, go, settle, brokenScreen } from './ui-support.mjs'
import { fingerprint } from './harness.mjs'

const audit = await startAudit({ port: Number(process.env.PORT ?? 5186) })
const { base, events, open, login, USERS, seed } = audit
const one = async (sql, params) => (await base.asOwner(sql, params))[0]
let checks = 0
let failures = 0
function check(ok, text, detail = '') {
  checks++
  console.log(`${ok ? '✔' : '✘'} ${text}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
async function step(page, name, action) {
  const errors = events.errors.length
  try {
    await action()
  } catch (error) {
    check(false, name, error.message.split('\n')[0])
    mkdirSync('output/audit/shots', { recursive: true })
    await page
      .screenshot({
        path: `output/audit/shots/${name.replace(/[^\wáéíóúñ]+/gi, '-')}.png`,
        fullPage: true,
      })
      .catch(() => {})
    return false
  }
  const broken = await brokenScreen(page)
  if (broken) check(false, `${name}: pantalla sana`, broken)
  for (const error of events.errors.slice(errors))
    check(false, `${name}: sin errores en consola`, error)
  return true
}
const NAME = 'PRUEBA-AUDITORIA'
const before = await fingerprint(base.asOwner)
const { page } = await open()
page.setDefaultTimeout(8000)

const monetaryValue = (text) => {
  if (!/\d/.test(text))
    throw new Error(`Importe pendiente en pantalla: ${text}`)
  return Number(text.replace(/[^\d.-]/g, ''))
}
async function accountingIncome({ remount = true } = {}) {
  if (remount) {
    await go(page, '/account')
    await go(page, '/accounting')
  } else {
    await page.getByRole('button', { name: 'Resumen', exact: true }).click()
    await settle(page)
  }
  const metric = page
    .locator('.accounting-metric')
    .filter({ has: page.getByText('Ventas del período', { exact: true }) })
  await metric.locator('strong').waitFor()
  const value = monetaryValue(await metric.locator('strong').innerText())
  const from = await page.getByLabel('Desde', { exact: true }).inputValue()
  const to = await page.getByLabel('Hasta', { exact: true }).inputValue()
  const expected = Number(
    (
      await one(
        `select coalesce(round(sum(c.net_revenue_nio),2),0) as revenue
    from public.documents d join public.document_item_costs c on c.document_id=d.id
    where d.kind='invoice' and (d.created_at at time zone 'America/Managua')::date between $1::date and $2::date`,
        [from, to],
      )
    ).revenue,
  )
  check(
    Math.abs(value - expected) < 0.005,
    'el ingreso del Resumen coincide con las ventas contables del período',
    `${value} frente a ${expected}`,
  )
  return value
}

try {
  await login(page, USERS.owner)

  // 1. Cliente
  await step(page, 'crear cliente desde Clientes', async () => {
    await go(page, '/customers')
    await page.getByRole('button', { name: 'Nuevo cliente' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nombre').fill(`${NAME} Cliente`)
    await dialog.getByLabel('Teléfono / WhatsApp').fill('8888 9999')
    await dialog.getByLabel('Correo').fill('prueba@example.com')
    await dialog.getByRole('button', { name: 'Guardar' }).click()
    await page.getByText('Cliente registrado').waitFor({ timeout: 8000 })
  })
  const customer = await one('select * from public.customers where name=$1', [
    `${NAME} Cliente`,
  ])
  check(
    !!customer && /88889999$/.test(customer.phone),
    `el cliente quedó en la base con el teléfono normalizado (${customer?.phone})`,
  )

  // 2. Proveedor
  await step(page, 'crear proveedor desde Proveedores', async () => {
    await go(page, '/suppliers')
    await page.getByRole('button', { name: /Nuevo proveedor/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nombre').fill(`${NAME} Proveedor`)
    await dialog.getByLabel('Correo').fill('proveedor@example.com')
    await dialog.getByRole('button', { name: 'Guardar' }).click()
    await page
      .getByText(new RegExp(`${NAME} Proveedor`))
      .first()
      .waitFor({ timeout: 8000 })
  })
  check(
    !!(await one('select 1 from public.suppliers where name=$1', [
      `${NAME} Proveedor`,
    ])),
    'el proveedor quedó en la base',
  )

  // 3. Perfume
  await step(page, 'crear perfume desde Inventario › nuevo', async () => {
    await go(page, '/products/new')
    await page.getByLabel('Nombre del perfume').fill(`${NAME} Perfume`)
    await page.getByLabel('Marca').fill('Casa de Auditoría')
    await page.getByLabel('Tamaño (vacío si falta confirmar)').fill('100')
    await page.getByLabel('Emprendedor USD').fill('50')
    await page.getByLabel('VIP USD').fill('48')
    await page.getByLabel('Premium USD').fill('46')
    await page.getByRole('button', { name: 'Guardar perfume' }).click()
    await page.waitForURL(/\/products\/[0-9a-f-]+\/edit/, { timeout: 10000 })
    await settle(page)
  })
  const product = await one('select * from public.products where name=$1', [
    `${NAME} Perfume`,
  ])
  check(!!product, 'el perfume quedó en la base')

  // 4. Conteo inicial en tienda desde la ficha del perfume.
  await step(page, 'contar existencias en la ficha del perfume', async () => {
    await page.getByLabel('Ubicación de las cantidades').selectOption('store')
    await page.getByLabel('Conteo total del perfume').fill('5')
    await page
      .getByLabel('Motivo del cambio de cantidad')
      .fill('Conteo de la auditoría')
    await page
      .getByRole('button', {
        name: /Guardar (cantidad|conteo|cambio|movimiento)/i,
      })
      .click()
    await settle(page)
    await page.waitForTimeout(500)
  })
  check(
    (
      await one(
        "select quantity from public.inventory_balances where product_id=$1 and location='store'",
        [product?.id],
      )
    )?.quantity === 5,
    'la tienda quedó con 5 unidades',
  )

  // 5. Factura de ventas con el cliente y el perfume de prueba.
  const incomeBeforeCashSale = await accountingIncome()
  const { page: salesPage, context: salesContext } = await open()
  let number = null
  salesPage.setDefaultTimeout(8000)
  await login(salesPage, USERS.sales)
  await step(salesPage, 'emitir factura desde Facturación', async () => {
    await go(salesPage, '/sales')
    await salesPage
      .getByLabel('Cliente registrado')
      .selectOption({
        label: new RegExp(`${NAME} Cliente`).source.replace(/\\/g, ''),
      })
      .catch(async () => {
        const select = salesPage.getByLabel('Cliente registrado')
        const value = await select.evaluate(
          (el, name) =>
            [...el.options].find((o) => o.text.includes(name))?.value,
          `${NAME} Cliente`,
        )
        await select.selectOption(value)
      })
    await salesPage.getByLabel('Buscar en catálogo').fill(NAME)
    await salesPage
      .getByRole('button', { name: new RegExp(`Agregar .*${NAME} Perfume`) })
      .first()
      .click()
    await salesPage.getByLabel('Forma de pago').selectOption({ index: 1 })
    await salesPage
      .getByLabel('Sale de')
      .selectOption('store')
      .catch(() => {})
    await salesPage.getByRole('button', { name: /^Emitir factura/ }).click()
    // Si pide confirmación, se confirma.
    const confirm = salesPage
      .getByRole('dialog')
      .getByRole('button', { name: /Emitir|Confirmar/ })
    if (await confirm.isVisible({ timeout: 1500 }).catch(() => false))
      await confirm.click()
    await salesPage
      .getByText(/FAC-\d+/)
      .first()
      .waitFor({ timeout: 10000 })
    number = (
      await salesPage
        .getByText(/FAC-\d+/)
        .first()
        .textContent()
    ).match(/FAC-\d+/)[0]
  })
  const invoice = number
    ? await one('select * from public.documents where number=$1', [number])
    : null
  check(
    !!invoice && invoice.customer_id === customer?.id,
    `factura ${number} en la base con el cliente de prueba`,
  )
  check(
    (
      await one(
        "select quantity from public.inventory_balances where product_id=$1 and location='store'",
        [product?.id],
      )
    )?.quantity === 4,
    'la factura descontó 1 unidad de tienda',
  )
  const invoiceRevenue = Number(
    (
      await one(
        'select sum(net_revenue_nio) as revenue from public.document_item_costs where document_id=$1',
        [invoice?.id],
      )
    ).revenue,
  )
  const incomeAfterCashSale = await accountingIncome()
  check(
    Math.abs(incomeAfterCashSale - incomeBeforeCashSale - invoiceRevenue) <
      0.005,
    'al volver a Contabilidad la factura cobrada actualiza el ingreso exactamente una vez',
  )
  // Sin IVA: la factura no desglosa impuesto, ni recién emitida ni al reabrirla.
  const printed = async () =>
    !/Impuesto/.test(await salesPage.evaluate(() => document.body.innerText))
  check(await printed(), 'la factura emitida no desglosa impuesto')
  await step(salesPage, 'reabrir la factura desde el historial', async () => {
    await go(salesPage, '/sales/history')
    await salesPage
      .getByRole('button', { name: 'Ver documento' })
      .first()
      .click()
    await settle(salesPage)
  })
  check(await printed(), 'reabierta desde el historial tampoco lo desglosa')
  await salesContext.close()

  // 6. La dueña elimina la factura desde el historial.
  await step(page, 'eliminar la factura desde el historial', async () => {
    await go(page, '/sales/history')
    await page
      .getByRole('button', { name: `Eliminar factura ${number}` })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Motivo (opcional)').fill('Prueba de auditoría')
    await dialog
      .getByRole('button', { name: /Eliminar/ })
      .last()
      .click()
    await page
      .getByText(new RegExp(`${number}.*eliminada|eliminada`))
      .first()
      .waitFor({ timeout: 8000 })
  })
  check(
    !(await one('select 1 from public.documents where number=$1', [number])),
    'la factura ya no está',
  )
  check(
    (
      await one(
        "select quantity from public.inventory_balances where product_id=$1 and location='store'",
        [product?.id],
      )
    )?.quantity === 5,
    'la unidad volvió a tienda',
  )
  check(
    Math.abs((await accountingIncome()) - incomeBeforeCashSale) < 0.005,
    'al eliminar la factura el Resumen restaura el ingreso anterior',
  )

  // 7. Dejar el perfume en cero y retirarlo.
  await step(page, 'dejar el perfume en cero', async () => {
    await go(page, `/products/${product.id}/edit`)
    await page.getByLabel('Ubicación de las cantidades').selectOption('store')
    await page
      .getByLabel('Cómo cambiar las cantidades')
      .selectOption({ label: /Ajuste|conteo/i.source })
      .catch(async () => {
        const select = page.getByLabel('Cómo cambiar las cantidades')
        const value = await select.evaluate(
          (el) =>
            [...el.options].find((o) => /ajust|conteo/i.test(o.text))?.value,
        )
        await select.selectOption(value)
      })
    await page.getByLabel('Conteo total del perfume').fill('0')
    await page
      .getByLabel('Motivo del cambio de cantidad')
      .fill('Fin de la auditoría')
    await page
      .getByRole('button', {
        name: /Guardar (cantidad|conteo|cambio|movimiento)/i,
      })
      .click()
    await settle(page)
    await page.waitForTimeout(500)
  })
  check(
    (
      await one(
        "select quantity from public.inventory_balances where product_id=$1 and location='store'",
        [product?.id],
      )
    )?.quantity === 0,
    'tienda en 0',
  )
  await step(page, 'retirar el perfume', async () => {
    await page.getByRole('button', { name: 'Retirar perfume' }).click()
    await page.getByRole('button', { name: 'Confirmar retiro' }).click()
    await settle(page)
    await page.waitForTimeout(500)
  })
  const retired = await one('select active from public.products where id=$1', [
    product?.id,
  ])
  check(
    retired?.active === false,
    'el perfume con historial quedó archivado (no se puede borrar del todo)',
  )

  // 8. Proveedor y cliente.
  await step(page, 'eliminar el proveedor', async () => {
    await go(page, '/suppliers')
    await page
      .getByRole('button', { name: `Eliminar ${NAME} Proveedor` })
      .click()
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'))
    const confirmField = dialog.getByRole('textbox')
    if (await confirmField.count())
      await confirmField.first().fill(`${NAME} Proveedor`)
    await dialog
      .getByRole('button', { name: /Eliminar/ })
      .last()
      .click()
    await settle(page)
    await page.waitForTimeout(500)
  })
  check(
    !(await one('select 1 from public.suppliers where name=$1', [
      `${NAME} Proveedor`,
    ])),
    'el proveedor ya no está',
  )
  await step(page, 'eliminar el cliente', async () => {
    await go(page, '/customers')
    await page.getByRole('button', { name: `Eliminar ${NAME} Cliente` }).click()
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'))
    const confirmField = dialog.getByRole('textbox')
    if (await confirmField.count())
      await confirmField.first().fill(`${NAME} Cliente`)
    await dialog
      .getByRole('button', { name: /Eliminar/ })
      .last()
      .click()
    await settle(page)
    await page.waitForTimeout(500)
  })
  // Con una factura eliminada ya no tiene documentos: se borra del todo.
  check(
    !(await one('select 1 from public.customers where id=$1', [customer?.id])),
    'el cliente ya no está (sin documentos se borra del todo)',
  )

  const after = await fingerprint(base.asOwner)
  const changed = Object.keys(after).filter(
    (t) => after[t].hash !== before[t].hash,
  )
  console.log(
    `\nRastro que el programa conserva a propósito: ${changed.map((t) => `${t} ${before[t].rows}→${after[t].rows}`).join(', ')}`,
  )
  const unexpected = changed.filter(
    (t) =>
      ![
        'private.catalog_changes',
        'private.contact_deletions',
        'private.document_deletions',
        'private.document_counters',
        'private.rate_limits',
        'public.products',
        'public.product_prices',
        'public.inventory_balances',
        'public.inventory_movements',
        'public.inventory_movement_costs',
        'public.brands',
        'public.user_drafts',
      ].includes(t),
  )
  check(
    unexpected.length === 0,
    'fuera del perfume archivado y las bitácoras, la base quedó como estaba',
    unexpected.join(', '),
  )

  // 9. Flujo contable independiente sobre otra copia de la base desechable.
  // La factura con abono conserva su historia; restore() solo restablece este
  // banco de pruebas aislado después de verificar el comportamiento del UI.
  await base.restore()
  const incomeBeforeCredit = await accountingIncome()
  const { page: creditSales, context: creditContext } = await open()
  creditSales.setDefaultTimeout(8000)
  await login(creditSales, USERS.sales)
  let creditNumber = null
  await step(
    creditSales,
    'emitir factura a crédito desde Facturación',
    async () => {
      await go(creditSales, '/sales')
      await creditSales
        .getByLabel('Cliente registrado')
        .selectOption(seed.customers[0])
      await creditSales.getByLabel('Buscar en catálogo').fill('Oud')
      await creditSales
        .getByRole('button', { name: /^Agregar .*Oud Nocturno/ })
        .first()
        .click()
      await creditSales.getByLabel('Forma de pago').selectOption('pending')
      await creditSales.getByRole('button', { name: /^Emitir factura/ }).click()
      await creditSales
        .getByText(/FAC-\d+/)
        .first()
        .waitFor({ timeout: 10000 })
      creditNumber = (
        await creditSales
          .getByText(/FAC-\d+/)
          .first()
          .innerText()
      ).match(/FAC-\d+/)[0]
    },
  )
  const creditInvoice = await one(
    'select * from public.documents where number=$1',
    [creditNumber],
  )
  check(
    creditInvoice?.payment_method === 'pending',
    `la factura ${creditNumber} quedó a crédito en la base`,
  )
  const creditRevenue = Number(
    (
      await one(
        'select sum(net_revenue_nio) as revenue from public.document_item_costs where document_id=$1',
        [creditInvoice?.id],
      )
    ).revenue,
  )
  const incomeAfterCredit = await accountingIncome()
  check(
    Math.abs(incomeAfterCredit - incomeBeforeCredit - creditRevenue) < 0.005,
    'la factura a crédito se incluye una vez en el ingreso del Resumen',
  )
  mkdirSync('output/audit/shots', { recursive: true })
  await page.screenshot({
    path: 'output/audit/shots/credit-summary-after-sale.png',
    fullPage: true,
  })
  await step(
    page,
    'registrar abono de factura desde Contabilidad',
    async () => {
      await page
        .getByRole('button', { name: 'Cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('button', { name: `Registrar abono a ${creditNumber}` })
        .click()
      const dialog = page.getByRole('dialog', { name: 'Registrar abono' })
      await dialog.getByLabel('Importe (NIO)').fill('100')
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page.getByText('Abono registrado.', { exact: true }).waitFor()
      await settle(page)
    },
  )
  const installment = await one(
    'select * from public.finance_entries where document_id=$1 and voided_at is null',
    [creditInvoice?.id],
  )
  check(
    installment?.kind === 'collection' && Number(installment.amount) === 100,
    'el abono de C$100 se guarda vinculado a su factura',
  )
  const creditRow = page
    .getByRole('table', { name: 'Cuentas por cobrar y pagar al corte' })
    .getByRole('row')
    .filter({ hasText: creditNumber })
  const paidInUi = monetaryValue(
    await creditRow.locator('td').nth(3).innerText(),
  )
  const remainingInUi = monetaryValue(
    await creditRow.locator('td').nth(4).innerText(),
  )
  check(
    paidInUi === 100 && Math.abs(remainingInUi - creditRevenue + 100) < 0.005,
    'la tabla se refresca después del abono con pagado y saldo correctos',
  )
  await page.screenshot({
    path: 'output/audit/shots/credit-abono-accounts.png',
    fullPage: true,
  })
  const incomeAfterInstallment = await accountingIncome({ remount: false })
  check(
    Math.abs(incomeAfterInstallment - incomeAfterCredit) < 0.005,
    'el abono no duplica los ingresos ni vuelve a registrar la venta',
  )
  await step(page, 'anular abono desde Caja y bancos', async () => {
    await page
      .getByRole('button', { name: 'Caja y bancos', exact: true })
      .click()
    const row = page
      .getByRole('table', { name: 'Movimientos del período' })
      .getByRole('row')
      .filter({ hasText: creditNumber })
    await row.getByRole('button', { name: /^Anular/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel('Motivo', { exact: true })
      .fill('Fin de la prueba de abonos')
    await dialog.getByRole('button', { name: 'Anular', exact: true }).click()
    await page.getByText('Movimiento anulado.', { exact: true }).waitFor()
    await page
      .getByRole('button', { name: 'Cobros y pagos', exact: true })
      .click()
    await settle(page)
  })
  const restoredRow = page
    .getByRole('table', { name: 'Cuentas por cobrar y pagar al corte' })
    .getByRole('row')
    .filter({ hasText: creditNumber })
  check(
    monetaryValue(await restoredRow.locator('td').nth(3).innerText()) === 0 &&
      monetaryValue(await restoredRow.locator('td').nth(4).innerText()) ===
        creditRevenue,
    'anular el abono restaura la deuda en pantalla y conserva su historia',
  )
  await creditContext.close()
  await base.restore()
  const afterFinancialReset = await fingerprint(base.asOwner)
  check(
    Object.keys(before).every(
      (table) => before[table].hash === afterFinancialReset[table].hash,
    ),
    'la copia desechable volvió al estado inicial tras el flujo de crédito',
  )
} catch (error) {
  check(false, 'recorrido completo', error.stack)
} finally {
  console.log(
    `\n${checks - failures} de ${checks} comprobaciones del recorrido por pantallas.`,
  )
  await audit.stop()
  process.exit(failures ? 1 : 0)
}
