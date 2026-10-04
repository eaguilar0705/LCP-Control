// Auditoría reproducible de venta → ingresos, costo, inventario y dinero.
// Todas las escrituras del negocio usan las RPC reales, con el rol de sesión.
// PGlite aplica las migraciones del repositorio en una base desechable.
// Vite sólo carga las funciones puras del resumen, sin abrir un servidor.
// Ejecutar: node tests/audit/sales-accounting.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createDatabase, fingerprint, USERS } from './harness.mjs'

const base = await createDatabase()
const loader = await createServer({
  configFile: false,
  envFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
})
const { asOwner, rpc } = base
const { owner, sales, warehouse } = USERS
const { accountingSummary } = await loader.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)
const { financePosition } = await loader.ssrLoadModule(
  '/src/features/accounting/finance.ts',
)
const day = (
  await asOwner(
    "select (now() at time zone 'America/Managua')::date::text as day",
  )
)[0].day
const range = { from: day, to: day }
const product = 'aaaaaaaa-1000-4000-8000-000000000001'
const uncosted = 'aaaaaaaa-1000-4000-8000-000000000002'
let scenarios = 0
let assertions = 0
const evidence = []
const equal = (actual, expected, message) => {
  assertions++
  assert.equal(actual, expected, message)
}
const same = (actual, expected, message) => {
  assertions++
  assert.deepEqual(actual, expected, message)
}
async function check(name, action) {
  await action()
  scenarios++
  console.log(`OK ${name}`)
}
const one = async (sql, params = []) => (await asOwner(sql, params))[0]
const readAs = (user, sql, params = []) =>
  base.asUser(user.id, async () => (await base.db.query(sql, params)).rows)
const document = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente de Casa del Perfume',
  tier: 'emprendedor',
  currency: 'NIO',
  location: 'store',
  paymentMethod: 'cash',
  notes: '',
  items: [{ productId: product, quantity: 1 }],
  ...changes,
})
const entry = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  occurredOn: day,
  kind: 'opening',
  account: 'caja',
  toAccount: null,
  amount: 1000,
  currency: 'NIO',
  exchangeRate: 1,
  counterparty: '',
  description: 'Auditoría local',
  reference: '',
  ...changes,
})
async function rejectedAtomic(user, name, args, pattern) {
  const before = await fingerprint(asOwner)
  assertions++
  await assert.rejects(rpc(user.id, name, args), pattern)
  same(
    await fingerprint(asOwner),
    before,
    `${name}: rechazar conserva todas las tablas`,
  )
}

// Compara la suma del servidor con el cálculo que usa la pantalla contable.
async function state() {
  const digest = await rpc(owner.id, 'report_digest', {
    p_from: day,
    p_to: day,
  })
  const salesByPayment = await rpc(owner.id, 'finance_sales', {
    p_from: day,
    p_to: day,
  })
  const cashflow = await rpc(owner.id, 'finance_cashflow', {
    p_from: day,
    p_to: day,
  })
  const credits = await rpc(owner.id, 'credit_accounts', { p_at: day })
  const costs = (await asOwner('select * from public.product_costs')).map(
    (row) => ({
      productId: row.product_id,
      averageCostNio:
        row.average_cost_nio == null ? null : Number(row.average_cost_nio),
    }),
  )
  const balances = await asOwner(
    'select product_id,location,quantity from public.inventory_balances',
  )
  const inventory = [product, uncosted].map((id) => ({
    product: { id },
    quantities: Object.fromEntries(
      balances
        .filter((row) => row.product_id === id)
        .map((row) => [row.location, row.quantity]),
    ),
  }))
  const shipments = (
    await asOwner(
      'select *,incurred_on::text as incurred_on from public.purchase_shipments',
    )
  ).map((row) => ({
    incurredOn: row.incurred_on,
    goodsAmount: Number(row.goods_amount),
    shippingAmount: Number(row.shipping_amount),
    units: row.units,
    exchangeRate: Number(row.exchange_rate),
    account: row.account,
  }))
  const expenses = (
    await asOwner(
      'select *,incurred_on::text as incurred_on from public.expense_records',
    )
  ).map((row) => ({
    incurredOn: row.incurred_on,
    amount: Number(row.amount),
    exchangeRate: Number(row.exchange_rate),
    account: row.account,
    category: row.category,
    voidedAt: row.voided_at,
  }))
  const entries = (
    await asOwner(
      'select *,occurred_on::text as occurred_on from public.finance_entries',
    )
  ).map((row) => ({
    occurredOn: row.occurred_on,
    kind: row.kind,
    account: row.account,
    toAccount: row.to_account,
    amount: Number(row.amount),
    exchangeRate: Number(row.exchange_rate),
    voidedAt: row.voided_at,
  }))
  const accounting = {
    available: true,
    truncated: false,
    costs,
    shipments,
    expenses,
    saleCosts: [],
  }
  const summary = accountingSummary(
    { ...digest, range, inventory, accounting, truncated: false },
    range,
  )
  const position = financePosition({
    available: true,
    startOn: day,
    at: day,
    entries,
    sales: salesByPayment,
    shipments: shipments.map((row) => ({
      amountNio: (row.goodsAmount + row.shippingAmount) * row.exchangeRate,
      account: row.account,
    })),
    expenses: expenses.map((row) => ({
      amountNio: row.amount * row.exchangeRate,
      account: row.account,
      financing: false,
      voided: !!row.voidedAt,
    })),
  })
  return {
    digest,
    summary,
    position,
    credits,
    cashflow,
    salesByPayment,
    inventory,
    costs,
  }
}
const expected = {
  revenue: 0,
  cost: 0,
  units: 0,
  stock: 10,
  caja: 1000,
  banco: 250,
  receivables: 0,
  cashSales: 0,
  bankSales: 0,
  creditSales: 0,
  expenses: 0,
}
async function consistent(label) {
  const current = await state()
  equal(
    current.digest.ledger.revenueNio,
    expected.revenue,
    `${label}: ingreso SQL`,
  )
  equal(
    current.summary.revenueNio,
    expected.revenue,
    `${label}: ingreso Resumen`,
  )
  equal(
    current.digest.ledger.costOfSalesNio,
    expected.cost,
    `${label}: costo SQL`,
  )
  equal(
    current.summary.grossProfitNio,
    expected.revenue - expected.cost,
    `${label}: utilidad bruta`,
  )
  equal(
    current.summary.netProfitNio,
    expected.revenue - expected.cost - expected.expenses,
    `${label}: utilidad neta`,
  )
  equal(
    current.summary.soldUnits,
    expected.units,
    `${label}: unidades vendidas`,
  )
  equal(
    current.summary.purchasesNio,
    750,
    `${label}: compra y flete registrados una sola vez`,
  )
  equal(
    current.summary.expensesNio,
    expected.expenses,
    `${label}: compra no se resta otra vez como gasto`,
  )
  equal(
    current.inventory[0].quantities.store,
    expected.stock,
    `${label}: tienda`,
  )
  equal(current.inventory[0].quantities.warehouse, 0, `${label}: bodega`)
  equal(
    current.costs.find((row) => row.productId === product).averageCostNio,
    75,
    `${label}: costo promedio`,
  )
  equal(
    current.summary.inventoryCostNio,
    expected.stock * 75,
    `${label}: inventario valorado`,
  )
  same(
    current.cashflow.closing,
    { caja: expected.caja, banco: expected.banco },
    `${label}: saldos SQL`,
  )
  same(
    current.position.cash,
    current.cashflow.closing,
    `${label}: saldos del navegador coinciden con SQL`,
  )
  equal(
    current.position.receivablesNio,
    expected.receivables,
    `${label}: CxC total`,
  )
  equal(
    current.credits.rows
      .filter((row) => row.kind === 'receivable')
      .reduce((sum, row) => sum + row.balanceNio, 0),
    expected.receivables,
    `${label}: CxC detallada`,
  )
  same(
    current.salesByPayment,
    {
      caja: expected.cashSales,
      banco: expected.bankSales,
      cobrar: expected.creditSales,
      missing: 0,
    },
    `${label}: venta según pago`,
  )
  equal(current.summary.complete, true, `${label}: contabilidad completa`)
  equal(current.cashflow.missingSales, 0, `${label}: cobros conocidos`)
  evidence.push({
    step: label,
    incomeNio: current.summary.revenueNio,
    costNio: current.summary.costOfSalesNio,
    profitNio: current.summary.netProfitNio,
    stock: expected.stock,
    ...current.cashflow.closing,
    receivables: current.position.receivablesNio,
  })
  return current
}
async function sale(changes = {}) {
  const input = document(changes)
  const saved = await rpc(sales.id, 'create_document', { p_payload: input })
  const quantity = input.items[0].quantity
  const amount = quantity * 120
  equal(
    Number(saved.total),
    quantity * (input.currency === 'USD' ? 4 : 120),
    `${saved.number}: precio de su moneda`,
  )
  expected.revenue += amount
  expected.cost += quantity * 75
  expected.units += quantity
  expected.stock -= quantity
  if (input.paymentMethod === 'pending') {
    expected.receivables += amount
    expected.creditSales += amount
  } else if (input.paymentMethod === 'cash') {
    expected.caja += amount
    expected.cashSales += amount
  } else {
    expected.banco += amount
    expected.bankSales += amount
  }
  return { input, saved }
}

try {
  await check(
    'preparación: perfume, conteos y compra por RPC, costo con flete C$75',
    async () => {
      await rpc(owner.id, 'set_exchange_rate', { p_rate: 30 })
      for (const [id, name] of [
        [product, 'Ámbar de auditoría'],
        [uncosted, 'Perfume sin costo histórico'],
      ]) {
        await rpc(owner.id, 'save_catalog_product', {
          p_payload: {
            id,
            revision: 0,
            name,
            brand: 'Casa del Perfume',
            size: 100,
            unit: 'ml',
            category: 'arabian',
            gender: 'unisex',
            manufacturerBarcode: '',
            minimumStock: 2,
            active: true,
            imagePath: null,
            prices: {
              emprendedor: { USD: 4, NIO: 0 },
              vip: { USD: 3.8, NIO: 0 },
              premium: { USD: 3.6, NIO: 0 },
            },
          },
        })
        for (const location of ['store', 'warehouse'])
          await rpc(owner.id, 'record_inventory_movement', {
            p_payload: {
              requestId: crypto.randomUUID(),
              productId: id,
              location,
              type: 'ADJUSTMENT',
              quantity: 0,
              note: 'Conteo inicial explícito',
            },
          })
      }
      for (const account of [
        'caja',
        'banco',
        'cobrar',
        'proveedores',
        'prestamos',
      ]) {
        await rpc(owner.id, 'record_finance_entry', {
          p_input: entry({
            account,
            amount: ['caja', 'banco'].includes(account) ? 1000 : 0,
          }),
        })
      }
      await rpc(owner.id, 'record_shipment', {
        p_input: {
          requestId: crypto.randomUUID(),
          incurredOn: day,
          supplier: 'Proveedor local',
          agency: 'Agencia de prueba',
          reference: 'AUD-COMPRA',
          note: '',
          currency: 'NIO',
          exchangeRate: 1,
          shippingAmount: 50,
          account: 'banco',
          lines: [
            {
              productId: product,
              location: 'store',
              quantity: 10,
              unitPrice: 70,
            },
          ],
        },
      })
      await consistent('Compra de 10 perfumes')
    },
  )
  let cashNio, credit
  await check(
    'venta de contado NIO: entra a ingresos, costo e inventario y caja',
    async () => {
      cashNio = await sale({ items: [{ productId: product, quantity: 2 }] })
      const current = await consistent('Contado NIO')
      equal(
        current.digest.sales.NIO.current.revenue,
        240,
        'reporte de ventas NIO',
      )
      equal(current.digest.sales.NIO.current.count, 1, 'una factura NIO')
    },
  )
  await check(
    'reintento idéntico no duplica factura, movimientos, ingresos ni dinero',
    async () => {
      const before = await fingerprint(asOwner)
      const again = await rpc(sales.id, 'create_document', {
        p_payload: cashNio.input,
      })
      equal(again.id, cashNio.saved.id, 'mismo identificador')
      same(await fingerprint(asOwner), before, 'reintento no escribe tablas')
      await rejectedAtomic(
        sales,
        'create_document',
        {
          p_payload: {
            ...cashNio.input,
            items: [{ productId: product, quantity: 3 }],
          },
        },
        /otros datos/,
      )
      await consistent('Reintento')
    },
  )
  await check(
    'venta USD en efectivo y ventas bancarias NIO/USD conservan método y tasa',
    async () => {
      await sale({ currency: 'USD', exchangeRate: 30 })
      await consistent('Contado USD')
      await sale({ paymentMethod: 'bac_nio' })
      await consistent('Banco NIO')
      await sale({
        currency: 'USD',
        exchangeRate: 30,
        paymentMethod: 'lafise_usd',
      })
      const current = await consistent('Banco USD')
      equal(
        current.digest.sales.NIO.current.revenue,
        360,
        'monedas no se mezclan en ventas',
      )
      equal(
        current.digest.sales.USD.current.revenue,
        8,
        'ventas USD sin convertir en su reporte',
      )
      same(
        current.digest.sales.USD.payments.map((row) => row.key).sort(),
        ['cash', 'lafise_usd'],
        'banco y moneda conservados',
      )
    },
  )
  await check(
    'venta a crédito reconoce ingreso/costo y deuda sin cobrar caja',
    async () => {
      credit = await sale({
        paymentMethod: 'pending',
        items: [{ productId: product, quantity: 2 }],
      })
      const current = await consistent('Crédito')
      const account = current.credits.rows.find(
        (row) => row.documentId === credit.saved.id,
      )
      equal(account.originalNio, 240, 'importe de factura a crédito')
      equal(account.paidNio, 0, 'sin abonos')
      equal(account.balanceNio, 240, 'saldo pendiente')
    },
  )
  let partial, partialId, full
  await check(
    'abono parcial en caja: baja deuda sin duplicar ventas ni costo',
    async () => {
      partial = entry({
        kind: 'collection',
        amount: 60,
        documentId: credit.saved.id,
        counterparty: 'Cliente de Casa del Perfume',
      })
      const id = await rpc(owner.id, 'record_finance_entry', {
        p_input: partial,
      })
      partialId = id
      expected.caja += 60
      expected.receivables -= 60
      const current = await consistent('Abono parcial')
      equal(
        current.credits.rows.find((row) => row.documentId === credit.saved.id)
          .paidNio,
        60,
        'abono vinculado a factura',
      )
      const retry = partial
      equal(
        await rpc(owner.id, 'record_finance_entry', { p_input: retry }),
        id,
        'abono idempotente',
      )
      await rejectedAtomic(
        owner,
        'record_finance_entry',
        { p_input: { ...retry, amount: 61 } },
        /otros datos/,
      )
      await rejectedAtomic(
        owner,
        'record_finance_entry',
        {
          p_input: entry({
            kind: 'collection',
            amount: 181,
            documentId: credit.saved.id,
          }),
        },
        /saldo pendiente/,
      )
    },
  )
  await check(
    'abono total USD en banco y posterior anulación reabren sólo la deuda/caja',
    async () => {
      full = await rpc(owner.id, 'record_finance_entry', {
        p_input: entry({
          kind: 'collection',
          account: 'banco',
          amount: 6,
          currency: 'USD',
          exchangeRate: 30,
          documentId: credit.saved.id,
        }),
      })
      expected.banco += 180
      expected.receivables = 0
      const current = await consistent('Crédito saldado')
      equal(
        current.credits.rows.find((row) => row.documentId === credit.saved.id)
          .balanceNio,
        0,
        'factura saldada sigue consultable',
      )
      await rejectedAtomic(
        owner,
        'record_finance_entry',
        {
          p_input: entry({
            kind: 'collection',
            amount: 1,
            documentId: credit.saved.id,
          }),
        },
        /saldo pendiente/,
      )
      await rpc(owner.id, 'void_finance_entry', {
        p_id: partialId,
        p_reason: 'Corregir cuenta del cobro',
      })
      expected.caja -= 60
      expected.receivables = 60
      await consistent('Abono parcial anulado')
      await rpc(owner.id, 'record_finance_entry', {
        p_input: entry({
          kind: 'collection',
          amount: 60,
          documentId: credit.saved.id,
        }),
      })
      expected.caja += 60
      expected.receivables = 0
      await consistent('Abono corregido')
      equal(!!full, true, 'abono bancario conservado')
    },
  )
  let proforma
  await check(
    'proforma no genera ingresos, costos, deuda, efectivo ni salida de inventario',
    async () => {
      proforma = await rpc(sales.id, 'create_document', {
        p_payload: document({
          kind: 'proforma',
          validUntil: '2099-01-01',
          items: [{ productId: product, quantity: 100 }],
        }),
      })
      const current = await consistent('Proforma de 100 unidades')
      equal(
        current.digest.sales.NIO.proformas,
        1,
        'proforma visible en su reporte',
      )
      equal(
        Number(
          (
            await one(
              'select count(*) as n from public.document_item_costs where document_id=$1',
              [proforma.id],
            )
          ).n,
        ),
        0,
        'sin costo congelado de proforma',
      )
      equal(
        Number(
          (
            await one(
              'select count(*) as n from public.inventory_movements where document_id=$1',
              [proforma.id],
            )
          ).n,
        ),
        0,
        'sin movimiento de proforma',
      )
      await rejectedAtomic(
        owner,
        'record_finance_entry',
        {
          p_input: entry({
            kind: 'collection',
            amount: 1,
            documentId: proforma.id,
          }),
        },
        /factura a crédito/,
      )
    },
  )
  await check(
    'gasto del período baja utilidad y caja; compra/flete no se descuentan dos veces',
    async () => {
      await rpc(owner.id, 'record_expense', {
        p_input: {
          requestId: crypto.randomUUID(),
          incurredOn: day,
          category: 'renta',
          description: 'Gasto de auditoría',
          amount: 30,
          currency: 'NIO',
          exchangeRate: 1,
          reference: 'AUD-GASTO',
          account: 'caja',
        },
      })
      expected.expenses = 30
      expected.caja -= 30
      await consistent('Gasto de C$30')
    },
  )
  await check(
    'tasa actual cambia, pero importes históricos de ventas/abonos permanecen',
    async () => {
      await rpc(owner.id, 'set_exchange_rate', { p_rate: 99 })
      await consistent('Tasa actual C$99')
    },
  )
  await check(
    'validaciones rechazan cantidades, stock, forma de pago, lista, tasa y roles sin escritura parcial',
    async () => {
      for (const [changes, pattern] of [
        [{ items: [{ productId: product, quantity: 1.5 }] }, /entera/],
        [{ items: [{ productId: product, quantity: 0 }] }, /rango/],
        [{ items: [{ productId: product, quantity: 100 }] }, /insuficientes/],
        [
          {
            items: [
              { productId: product, quantity: 1 },
              { productId: product, quantity: 1 },
            ],
          },
          /repitas/,
        ],
        [{ paymentMethod: 'paypal' }, /forma de pago/],
        [{ tier: 'vip' }, /dueño/],
        [{ currency: 'USD' }, /tasa|numérico/],
      ])
        await rejectedAtomic(
          sales,
          'create_document',
          { p_payload: document(changes) },
          pattern,
        )
      await rejectedAtomic(
        warehouse,
        'create_document',
        { p_payload: document() },
        /privilege|permission|insufficient/,
      )
      await consistent('Validaciones')
    },
  )
  await check(
    'eliminar factura de contado devuelve existencias y revierte ingreso, costo y caja con bitácora',
    async () => {
      equal(
        await rpc(owner.id, 'delete_invoice', {
          p_id: cashNio.saved.id,
          p_reason: 'Anulación en auditoría',
        }),
        cashNio.saved.number,
        'se elimina factura correcta',
      )
      expected.revenue -= 240
      expected.cost -= 150
      expected.units -= 2
      expected.stock += 2
      expected.caja -= 240
      expected.cashSales -= 240
      await consistent('Factura de contado eliminada')
      equal(
        Number(
          (
            await one(
              'select count(*) as n from private.document_deletions where document_id=$1',
              [cashNio.saved.id],
            )
          ).n,
        ),
        1,
        'historial de factura eliminada',
      )
      await rejectedAtomic(
        owner,
        'delete_invoice',
        { p_id: cashNio.saved.id, p_reason: 'Reintento' },
        /no existe/,
      )
      await rejectedAtomic(
        owner,
        'delete_invoice',
        { p_id: credit.saved.id, p_reason: 'No borrar abonos históricos' },
        /abonos/,
      )
      await rejectedAtomic(
        owner,
        'delete_invoice',
        { p_id: proforma.id, p_reason: 'No es factura' },
        /Sólo/,
      )
    },
  )
  await check(
    'un reintento tardío de una factura eliminada no resucita la venta',
    async () => {
      await rejectedAtomic(
        sales,
        'create_document',
        { p_payload: cashNio.input },
        /eliminada|anulada/,
      )
      await rejectedAtomic(
        sales,
        'create_document',
        {
          p_payload: {
            ...cashNio.input,
            notes: 'Cambiar datos tampoco la recrea',
          },
        },
        /eliminada|anulada/,
      )
      await rejectedAtomic(
        sales,
        'create_document',
        {
          p_payload: {
            ...cashNio.input,
            kind: 'proforma',
            validUntil: '2099-01-01',
          },
        },
        /eliminada|anulada/,
      )
      await consistent('Reintento tras eliminación')
    },
  )
  await check(
    'el bloqueo de una factura eliminada pertenece a su autor original y no colisiona con otra sesión',
    async () => {
      const before = await state()
      // Otro usuario tiene su propio espacio de requestId; el autor original
      // fue ventas, aunque quien eliminó la factura fue la dueña.
      const other = await rpc(owner.id, 'create_document', {
        p_payload: cashNio.input,
      })
      equal(
        other.id === cashNio.saved.id,
        false,
        'otra persona produce una factura nueva',
      )
      equal(
        Number(other.total),
        792,
        'la nueva operación usa el catálogo actual C$396 × 2',
      )
      const after = await state()
      equal(
        after.summary.revenueNio,
        before.summary.revenueNio + 792,
        'ingreso nuevo pertenece a nueva factura',
      )
      equal(
        after.cashflow.closing.caja,
        before.cashflow.closing.caja + 792,
        'cobro de otra operación',
      )
      equal(
        after.inventory[0].quantities.store,
        before.inventory[0].quantities.store - 2,
        'salida de otra operación',
      )
      equal(
        await rpc(owner.id, 'delete_invoice', {
          p_id: other.id,
          p_reason: 'Restaurar auditoría multisesión',
        }),
        other.number,
        'otra factura eliminada con bitácora',
      )
      await rejectedAtomic(
        owner,
        'create_document',
        { p_payload: cashNio.input },
        /eliminada|anulada/,
      )
      await rejectedAtomic(
        sales,
        'create_document',
        { p_payload: cashNio.input },
        /eliminada|anulada/,
      )
      await consistent('Identidad del autor conservada')
    },
  )
  await check(
    'ventas puede facturar y ver ingresos propios; costos y caja/deudas quedan protegidos',
    async () => {
      const digest = await rpc(sales.id, 'report_digest', {
        p_from: day,
        p_to: day,
      })
      equal(digest.ledger, null, 'ventas no recibe libro de costos')
      equal(
        digest.sales.NIO.current.revenue,
        360,
        'ventas ve ingresos NIO propios vigentes',
      )
      equal(
        digest.sales.USD.current.revenue,
        8,
        'ventas ve ingresos USD propios vigentes',
      )
      equal(
        (await readAs(sales, 'select * from public.product_costs')).length,
        0,
        'RLS oculta costos',
      )
      equal(
        (await readAs(sales, 'select * from public.finance_entries')).length,
        0,
        'RLS oculta movimientos financieros',
      )
      for (const [name, args] of [
        ['finance_cashflow', { p_from: day, p_to: day }],
        ['credit_accounts', { p_at: day }],
        [
          'record_finance_entry',
          { p_input: entry({ kind: 'capital', amount: 1 }) },
        ],
        [
          'delete_invoice',
          { p_id: credit.saved.id, p_reason: 'Rol sin permiso' },
        ],
      ])
        await rejectedAtomic(
          sales,
          name,
          args,
          /privilege|permission|insufficient/,
        )
    },
  )
  await check(
    'sin costo histórico el ingreso conocido se conserva y la utilidad permanece desconocida',
    async () => {
      await rpc(owner.id, 'record_inventory_movement', {
        p_payload: {
          requestId: crypto.randomUUID(),
          productId: uncosted,
          location: 'store',
          type: 'ADJUSTMENT',
          quantity: 2,
          note: 'Conteo sin factura de costo',
        },
      })
      const saved = await rpc(sales.id, 'create_document', {
        p_payload: document({
          currency: 'USD',
          exchangeRate: 30,
          items: [{ productId: uncosted, quantity: 1 }],
        }),
      })
      equal(Number(saved.total), 4, 'precio USD conocido')
      const current = await state()
      equal(
        current.summary.revenueNio,
        expected.revenue + 120,
        'ingreso sigue tasa histórica de factura',
      )
      equal(current.summary.missingCostUnits, 1, 'unidad con costo desconocido')
      equal(current.summary.grossProfitNio, null, 'utilidad bruta no inventada')
      equal(current.summary.netProfitNio, null, 'utilidad neta no inventada')
      equal(current.summary.complete, false, 'reporte advierte falta de costo')
      equal(
        current.cashflow.closing.caja,
        expected.caja + 120,
        'caja conocida aunque costo sea desconocido',
      )
      equal(
        current.cashflow.missingSales,
        0,
        'importe conocido no confundido con costo faltante',
      )
      equal(
        current.inventory[1].quantities.store,
        1,
        'perfume sin costo también descuenta existencias',
      )
    },
  )
  console.log('\nEVIDENCIA venta → contabilidad (C$):')
  console.table(evidence)
  console.log(
    `${scenarios} escenarios y ${assertions} comprobaciones aprobados. Base PostgreSQL desechable; ningún dato real modificado.`,
  )
} finally {
  await loader.close()
  await base.db.close()
}
