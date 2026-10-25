import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
} from './database-fixture.mjs'

// No red ni credenciales: migraciones reales en PostgreSQL desechable.
// Los fallos inducidos prueban atomicidad después de guardar renglones previos.
const db = await database()
const started = performance.now()
const day = '2026-10-24'
const nextDay = '2026-10-25'
const rate = 36.6
const products = []
const scenarios = []
const findings = []
let checks = 0
let server
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100)
const money = (value) => cents(value) / 100
const eq = (actual, expected, reason) => {
  assert.deepEqual(actual, expected, reason)
  checks++
}
const ok = (value, reason) => {
  assert.ok(value, reason)
  checks++
}
const query = async (sql, args = []) => (await db.query(sql, args)).rows
const call = (name, input) => rpc(db, name, input)
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await query(sql, args)
  } finally {
    await db.exec('set role authenticated').catch(() => {})
  }
}
const clock = (date = day, time = '14:00:00') =>
  db.query("select set_config('lcp.test_now',$1,false)", [`${date}T${time}Z`])
const currentDay = async () =>
  (await query('select public.get_business_day(null) r'))[0].r
const ledger = async (to = day) =>
  (await query('select public.ledger_report($1,$2) r', [day, to]))[0].r
const debit = (report, account) =>
  report.accounts.find((a) => a.code === account).debit
const credit = (report, account) =>
  report.accounts.find((a) => a.code === account).credit
const snapshotTables = [
  'public.customers',
  'public.documents',
  'public.document_items',
  'public.document_item_costs',
  'public.inventory_balances',
  'public.inventory_movements',
  'public.inventory_movement_costs',
  'public.product_costs',
  'public.product_prices',
  'public.purchase_shipments',
  'public.purchase_shipment_lines',
  'public.journal_entries',
  'public.journal_lines',
  'public.finance_entries',
  'public.expense_records',
  'public.business_days',
  'private.document_counters',
  'private.document_deletions',
  'private.business_day_events',
]
async function snapshot() {
  return (
    await owner(
      `select jsonb_build_object(${snapshotTables
        .map(
          (table) =>
            `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from ${table} t)`,
        )
        .join(',')}) r`,
    )
  )[0].r
}
async function rejected(name, work, pattern) {
  const before = await snapshot()
  await db.exec('savepoint expected_failure')
  try {
    await assert.rejects(work, pattern, name)
    checks++
  } finally {
    await db.exec(
      'rollback to savepoint expected_failure; release savepoint expected_failure',
    )
  }
  eq(await snapshot(), before, `${name}: rechazo sin escritura parcial`)
}
async function scenario(name, work) {
  await db.exec('begin')
  try {
    await clock()
    await work()
    scenarios.push(name)
    console.log(`PASS ${name}`)
  } finally {
    await db.exec('rollback')
    await identity(db, admin)
  }
}
function invoice(changes = {}, count = 3) {
  const currency = changes.currency ?? 'NIO'
  const items = products.slice(0, count).map((product, index) => ({
    productId: product.id,
    quantity: 1 + (index % 4),
    expectedUnitPrice: product.prices[currency],
  }))
  return {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente aislado, María O’Connor',
    customerPhone: '88880001',
    customerTaxId: 'QA-RUC-001',
    tier: 'emprendedor',
    currency,
    exchangeRate: currency === 'USD' ? rate : 1,
    paymentMethod: 'cash',
    location: 'store',
    notes: 'Entrega completa. Línea dos: ñ, tildes y comillas “texto”.',
    expectedTotal: money(
      items.reduce(
        (sum, item) => sum + item.quantity * item.expectedUnitPrice,
        0,
      ),
    ),
    items,
    ...changes,
  }
}
const shipment = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  incurredOn: day,
  supplier: 'Proveedor aislado',
  reference: 'QA-COMPRA-001',
  currency: 'NIO',
  exchangeRate: 1,
  account: 'credito',
  shippingAmount: 100,
  lines: products.slice(0, 3).map((product) => ({
    productId: product.id,
    location: 'warehouse',
    quantity: 10,
    unitPrice: 150,
  })),
  ...changes,
})
const voucher = (lines, changes = {}) => ({
  requestId: crypto.randomUUID(),
  occurredOn: day,
  kind: 'income',
  description: 'Comprobante aislado de integridad',
  reference: 'QA',
  currency: 'NIO',
  exchangeRate: 1,
  lines,
  ...changes,
})
const collection = (documentId, amount, changes = {}) => ({
  requestId: crypto.randomUUID(),
  occurredOn: day,
  kind: 'collection',
  account: 'caja',
  currency: 'NIO',
  exchangeRate: 1,
  description: 'Cobro aislado',
  documentId,
  amount,
  ...changes,
})
async function close() {
  const state = await currentDay()
  const input = {
    requestId: crypto.randomUUID(),
    day: state.day,
    expectedRevision: state.revision,
    expectedStateToken: state.stateToken,
    countedNio: state.report.expectedNio,
    countedUsd: state.report.expectedUsd,
    note: '',
  }
  const result = await call('close_business_day', input)
  return { input, result }
}
async function checkLedger(to = day) {
  const report = await ledger(to)
  eq(report.missingCosts, 0, 'Sin costos pendientes')
  eq(report.missingSales, 0, 'Sin ventas incompletas')
  eq(
    cents(report.accounts.reduce((sum, a) => sum + a.debit, 0)),
    cents(report.accounts.reduce((sum, a) => sum + a.credit, 0)),
    'Debe = Haber',
  )
  const model = journalModel(report, 'Empresa aislada')
  eq(
    model.balance.left.at(-1).amount,
    model.balance.right.at(-1).amount,
    'Activo = Pasivo + Capital + Resultado acumulado',
  )
  ok(model.trialTotals.closingNio !== null, 'Balanza disponible')
  eq(model.trialTotals.closingNio === 0, true, 'Balanza de comprobación cuadra')
  eq(model.warnings, [], 'No advertencias contables ocultas')
  return report
}
let journalModel
try {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../frontend', import.meta.url)),
    cacheDir: fileURLToPath(
      new URL('../../output/cache/enterprise-integrity', import.meta.url),
    ),
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { noExternal: ['@lcp/contracts'] },
  })
  ;({ journalModel } = await server.ssrLoadModule(
    '/src/features/accounting/journalModel.ts',
  ))
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await clock()
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración QA','superadmin'),($2,'Caja QA','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.brands(name) values('Marca QA'); insert into public.business_settings(name,legal_name,tax_id,address,phone,email,branch,billing_details) values('Tienda QA','Empresa QA S.A.','QA-RUC','Dirección QA','88880000','tienda@example.invalid','Sucursal QA','Dato adicional QA')",
  )
  for (let index = 0; index < 100; index++) {
    const product = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
      name: `Perfume QA ${index + 1}`,
      cost: money(100 + index / 10),
      prices: { NIO: money(200 + index * 0.37), USD: money(6 + index * 0.01) },
    }
    products.push(product)
    await db.query(
      "insert into public.products(id,sku,name,brand_id,size,unit) values($1,$2,$3,(select id from public.brands limit 1),3.4,'oz')",
      [product.id, `QA-INT-${index + 1}`, product.name],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',200),($1,'warehouse',80)",
      [product.id],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
      [product.id, product.cost],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',$2),($1,'emprendedor','USD',$3)",
      [product.id, product.prices.NIO, product.prices.USD],
    )
  }
  await identity(db, admin)
  const inventoryValue = money(
    products.reduce((sum, product) => sum + product.cost * 280, 0),
  )
  await call(
    'record_journal_entry',
    voucher(
      [
        { account: '1110-001', debit: 10000, credit: 0 },
        { account: '1110-002', debit: 3660, credit: 0 },
        { account: '1120-001', debit: 50000, credit: 0 },
        { account: '1130', debit: inventoryValue, credit: 0 },
        {
          account: '3110-001',
          debit: 0,
          credit: money(inventoryValue + 63660),
        },
      ],
      { kind: 'opening' },
    ),
  )
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 10000,
    openingUsd: 100,
  })

  await scenario(
    'Factura de 100 productos conserva cabecera, líneas, costos y asientos completos',
    async () => {
      const input = invoice({}, 100)
      const document = await call('create_document', input)
      eq(document.items.length, 100)
      eq(Number(document.total), input.expectedTotal)
      eq(document.customer_name, input.customerName)
      eq(document.customer_phone, input.customerPhone)
      eq(document.customer_tax_id, input.customerTaxId)
      eq(document.notes, input.notes)
      eq(document.currency, 'NIO')
      eq(document.location, 'store')
      eq(document.payment_method, 'cash')
      for (const [key, value] of Object.entries({
        name: 'Tienda QA',
        legal_name: 'Empresa QA S.A.',
        tax_id: 'QA-RUC',
        address: 'Dirección QA',
        phone: '88880000',
        email: 'tienda@example.invalid',
        branch: 'Sucursal QA',
        billing_details: 'Dato adicional QA',
      }))
        eq(document.issuer[key], value, `Emisor completo: ${key}`)
      const costs = await query(
        'select * from public.document_item_costs where document_id=$1 order by product_id',
        [document.id],
      )
      const movements = await query(
        "select * from public.inventory_movements where document_id=$1 and type='SALE' order by product_id",
        [document.id],
      )
      eq(costs.length, 100)
      eq(movements.length, 100)
      for (let index = 0; index < products.length; index++) {
        const product = products[index]
        const item = document.items.find(
          (line) => line.product_id === product.id,
        )
        eq(item.quantity, input.items[index].quantity)
        eq(Number(item.unit_price), product.prices.NIO)
        ok(item.description.includes(product.name), 'Descripción persistida')
        eq(Number(costs[index].unit_cost_nio), product.cost)
        eq(
          Number(costs[index].net_revenue_nio),
          money(item.quantity * product.prices.NIO),
        )
        eq(Number(costs[index].tax_nio), 0)
        eq(movements[index].after_quantity, 200 - item.quantity)
      }
      const report = await checkLedger()
      eq(credit(report, '4110'), input.expectedTotal)
      const after = await snapshot()
      for (let retry = 0; retry < 15; retry++)
        eq(
          await call('create_document', input),
          document,
          'Reintento devuelve exactamente el documento guardado',
        )
      eq(await snapshot(), after, 'Quince reintentos no duplican ninguna fila')
      for (const sql of [
        "update public.business_settings set name='Otro nombre',tax_id='OTRO-RUC'",
        "update public.customers set name='Otro cliente',phone='88889999'",
        "update public.products set name='Nuevo nombre'",
        'update public.product_prices set amount=9999',
        'update public.product_costs set average_cost_nio=999',
      ])
        await owner(sql)
      eq(
        await call('create_document', input),
        document,
        'Editar catálogos no reescribe documento emitido',
      )
      const oldCosts = await query(
        'select * from public.document_item_costs where document_id=$1 order by product_id',
        [document.id],
      )
      eq(
        oldCosts,
        costs,
        'Costo e ingreso histórico no cambian al editar costo y precio',
      )
    },
  )

  await scenario(
    'Errores humanos y formularios alterados se rechazan sin guardar datos parciales',
    async () => {
      const cases = [
        ['sin productos', { items: [] }, /entre 1 y 100/],
        [
          'producto repetido',
          {
            items: [
              { productId: products[0].id, quantity: 1 },
              { productId: products[0].id, quantity: 2 },
            ],
          },
          /No repitas/,
        ],
        [
          'cantidad cero',
          { items: [{ productId: products[0].id, quantity: 0 }] },
          /fuera de rango/,
        ],
        [
          'cantidad negativa',
          { items: [{ productId: products[0].id, quantity: -1 }] },
          /fuera de rango/,
        ],
        [
          'cantidad decimal',
          { items: [{ productId: products[0].id, quantity: 1.5 }] },
          /entera/,
        ],
        [
          'cantidad como texto',
          { items: [{ productId: products[0].id, quantity: '2' }] },
          /entera/,
        ],
        [
          'falta producto',
          { items: [{ quantity: 1 }] },
          /No repitas|disponible/,
        ],
        [
          'cliente vacío',
          { customerName: '  ', customerPhone: '' },
          /nombre del cliente/,
        ],
        ['RUC excesivo', { customerTaxId: 'Q'.repeat(81) }, /RUC/],
        ['nota excesiva', { notes: 'N'.repeat(2001) }, /nota/],
        ['moneda inválida', { currency: 'EUR' }, /moneda/],
        ['lista ausente', { tier: 'inexistente' }, /lista/],
        ['pago inválido', { paymentMethod: 'mixto' }, /forma de pago/],
        ['ubicación ausente', { location: null }, /ubicación/],
        ['total manipulado', { expectedTotal: 0 }, /precios cambiaron/],
        [
          'precio manipulado',
          {
            items: [
              { productId: products[0].id, quantity: 1, expectedUnitPrice: 0 },
            ],
          },
          /precios cambiaron/,
        ],
        [
          'stock insuficiente',
          { items: [{ productId: products[0].id, quantity: 201 }] },
          /insuficientes/,
        ],
        [
          'proforma vencida',
          { kind: 'proforma', validUntil: '2026-10-23' },
          /vigencia/,
        ],
        [
          'tasa incorrecta en córdobas',
          { exchangeRate: rate },
          /tipo de cambio|conversión|tasa/i,
        ],
        [
          'USD sin tipo de cambio',
          {
            currency: 'USD',
            exchangeRate: null,
            expectedTotal: 6,
            items: [{ productId: products[0].id, quantity: 1 }],
          },
          /tipo de cambio|tasa|numérico/i,
        ],
      ]
      for (const [name, changes, pattern] of cases)
        await rejected(
          name,
          () => call('create_document', invoice(changes)),
          pattern,
        )
      await checkLedger()
    },
  )

  await scenario(
    'Fallo técnico en el último renglón revierte factura, cliente, numeración, existencias y costos',
    async () => {
      await owner(
        `create function public.qa_fail_last_item() returns trigger language plpgsql as $$begin if new.product_id='${products.at(-1).id}'::uuid and current_setting('lcp.qa_fail',true)='on' then raise exception 'FALLO_QA_ULTIMO_RENGLON'; end if; return new; end$$`,
      )
      await owner(
        'create trigger zz_qa_fail_last_item after insert on public.document_items for each row execute function public.qa_fail_last_item()',
      )
      await db.query("select set_config('lcp.qa_fail','on',false)")
      const input = invoice({}, 100)
      await rejected(
        'fallo después de 99 renglones completos',
        () => call('create_document', input),
        /FALLO_QA/,
      )
      await db.query("select set_config('lcp.qa_fail','off',false)")
      const document = await call('create_document', input)
      eq(
        document.number,
        'FAC-000001',
        'Una operación fallida no consume el consecutivo',
      )
      eq(document.items.length, 100)
      await checkLedger()
    },
  )

  await scenario(
    'Compra con último producto no disponible revierte costo promedio, entrada y pedido completos',
    async () => {
      const input = shipment({
        lines: [
          {
            productId: products[0].id,
            location: 'store',
            quantity: 10,
            unitPrice: 1000,
          },
          {
            productId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            location: 'warehouse',
            quantity: 5,
            unitPrice: 900,
          },
        ],
      })
      await rejected(
        'pedido incompleto al final',
        () => call('record_shipment', input),
        /no encontrado|inactivo/,
      )
      const corrected = {
        ...input,
        lines: [
          input.lines[0],
          { ...input.lines[1], productId: products[1].id },
        ],
      }
      const id = await call('record_shipment', corrected)
      eq(
        await call('record_shipment', corrected),
        id,
        'Reintento de compra no duplica entradas',
      )
      eq(
        (
          await query(
            'select count(*)::int n from public.purchase_shipment_lines where shipment_id=$1',
            [id],
          )
        )[0].n,
        2,
      )
      for (const [index, quantity, unit] of [
        [0, 10, 1000],
        [1, 5, 900],
      ]) {
        const savedCost = Number(
          (
            await query(
              'select average_cost_nio from public.product_costs where product_id=$1',
              [products[index].id],
            )
          )[0].average_cost_nio,
        )
        const landed =
          Math.round((unit + Math.round((100 / 15) * 1e6) / 1e6) * 1e6) / 1e6
        const expected =
          Math.round(
            ((products[index].cost * 280 + landed * quantity) /
              (280 + quantity)) *
              1e6,
          ) / 1e6
        eq(
          savedCost,
          expected,
          'Costo promedio ponderado incluye Tienda + Bodega + Envío',
        )
        eq(
          Number(
            (
              await query(
                "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='NIO'",
                [products[index].id],
              )
            )[0].amount,
          ),
          products[index].prices.NIO,
          'Costo y precio de venta manual son independientes',
        )
      }
      const report = await checkLedger()
      eq(
        credit(report, '2111'),
        14600,
        'Deuda proveedor incluye mercancía y envío',
      )
    },
  )

  await scenario(
    'Crédito, abonos, errores de moneda y corrección conservan saldo y libro mayor',
    async () => {
      const input = invoice({ paymentMethod: 'pending' }, 1)
      const document = await call('create_document', input)
      const first = collection(document.id, 25)
      const paymentId = await call('record_finance_entry', first)
      eq(await call('record_finance_entry', first), paymentId)
      let report = await checkLedger()
      eq(report.accounts.find((a) => a.code === '1140').closing, 175)
      eq(credit(report, '4110'), 200, 'Cobrar no registra una segunda venta')
      await rejected(
        'abono mayor al saldo',
        () => call('record_finance_entry', collection(document.id, 175.01)),
        /supera/,
      )
      await rejected(
        'abono sin factura seleccionada',
        () => call('record_finance_entry', collection(null, 10)),
        /saldo inicial|saldo pendiente|supera/,
      )
      await rejected(
        'abono en banco de otra moneda',
        () =>
          call(
            'record_finance_entry',
            collection(document.id, 1, {
              account: 'banco',
              bankLedgerAccount: '1120-002',
            }),
          ),
        /moneda/,
      )
      await rejected(
        'anular factura con abonos',
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            document.id,
            'Me equivoqué de cliente',
          ]),
        /abonos/,
      )
      await db.query('select public.void_finance_entry($1,$2)', [
        paymentId,
        'Pago registrado por equivocación',
      ])
      eq(
        (await checkLedger()).accounts.find((a) => a.code === '1140').closing,
        200,
      )
      await rejected(
        'conservar factura aun con abono anulado',
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            document.id,
            'Cliente equivocado; se emitirá de nuevo',
          ]),
        /abonos/,
      )
      findings.push({
        severity: 'medium',
        status: 'open',
        key: 'credit_correction_after_voided_collection',
        reproduction:
          'Factura a crédito; cobro equivocado; anular el cobro; intentar corregir/anular factura.',
        actual:
          'Se conserva el documento porque mantiene el vínculo con el abono anulado. No existe nota de crédito ni corrección vinculada para el usuario.',
        proposed:
          'Incorporar corrección o nota de crédito auditada, sin borrar abonos ni reescribir cierres.',
      })
      const cleanInput = invoice({ customerPhone: '88880002' }, 1)
      const clean = await call('create_document', cleanInput)
      const number = (
        await db.query('select public.delete_invoice($1,$2) r', [
          clean.id,
          'Cliente equivocado; se emitirá de nuevo',
        ])
      ).rows[0].r
      eq(number, clean.number)
      const after = await snapshot()
      await rejected(
        'no devolver dos veces el inventario',
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            clean.id,
            'Cliente equivocado; se emitirá de nuevo',
          ]),
        /ya no existe/,
      )
      await rejected(
        'repetir emisión anulada',
        () => call('create_document', cleanInput),
        /eliminad|anulad/i,
      )
      eq(await snapshot(), after)
      report = await checkLedger()
      eq(credit(report, '4110'), 200)
      eq(report.accounts.find((a) => a.code === '1140').closing, 200)
    },
  )

  await scenario(
    'Redondeo USD, POS y liquidación conservan centavos en caja y bancos',
    async () => {
      const cash = await call(
        'create_document',
        invoice({ currency: 'USD' }, 100),
      )
      const pos = await call(
        'create_document',
        invoice({ currency: 'USD', paymentMethod: 'card_pos' }, 1),
      )
      const gross = Number(pos.total)
      const fee = money((gross * 4.5) / 100)
      const withholding = money((gross * 1.5) / 100)
      const net = money(gross - fee - withholding)
      const input = voucher(
        [
          { account: '1120-002', debit: net, credit: 0 },
          { account: '5140-001', debit: fee, credit: 0 },
          { account: '1340', debit: withholding, credit: 0 },
          { account: '1142', debit: 0, credit: gross },
        ],
        {
          kind: 'card_settlement',
          currency: 'USD',
          exchangeRate: rate,
          gross,
          commissionRate: 4.5,
          withholdingRate: 1.5,
          withholdingBase: 'gross',
          bankAccount: '1120-002',
        },
      )
      // Sólo POS USD calculado distribuye el centavo en el neto bancario.
      const debitNio =
        money(net * rate) + money(fee * rate) + money(withholding * rate)
      const roundingNio = money(money(gross * rate) - debitNio)
      eq(
        roundingNio,
        0.01,
        'Reproducción del centavo que antes bloqueaba guardar',
      )
      await rejected(
        'comprobante manual mantiene validación estricta',
        () =>
          call('record_journal_entry', {
            ...input,
            requestId: crypto.randomUUID(),
            kind: 'income',
          }),
        /debe y el haber/,
      )
      const altered = structuredClone(input)
      altered.requestId = crypto.randomUUID()
      altered.lines[0].debit = money(net + 0.01)
      await rejected(
        'POS calculado no acepta alterar renglones',
        () => call('record_journal_entry', altered),
        /no coinciden/,
      )
      const wrongBank = structuredClone(input)
      wrongBank.requestId = crypto.randomUUID()
      wrongBank.bankAccount = '1120-001'
      wrongBank.lines[0].account = '1120-001'
      await rejected(
        'POS USD no puede entrar a banco C$',
        () => call('record_journal_entry', wrongBank),
        /moneda/,
      )
      const id = await call('record_journal_entry', input)
      const after = await snapshot()
      eq(await call('record_journal_entry', input), id)
      eq(await snapshot(), after, 'Liquidación repetida no acredita dos veces')
      const lines = await query(
        'select * from public.journal_lines where entry_id=$1 order by line_no',
        [id],
      )
      const bank = lines.find((line) => line.account === '1120-002')
      eq(Number(bank.debit), net, 'El importe original USD conserva5.64')
      eq(Number(bank.debit_nio), money(money(net * rate) + roundingNio))
      eq(
        cents(lines.reduce((sum, line) => sum + Number(line.debit_nio), 0)),
        cents(lines.reduce((sum, line) => sum + Number(line.credit_nio), 0)),
      )
      findings.push({
        severity: 'high',
        status: 'fixed',
        key: 'usd_pos_settlement_rounding',
        reproduction:
          'Venta POS de US$6; liquidar a 36.6 con comisión de 4.5% y retención de 1.5%.',
        actual:
          'Antes se bloqueaba guardar por una diferencia de conversión C$0.01.',
        resolution:
          'La liquidación POS USD validada asigna hasta C$0.02 de diferencia al banco destino; los importes USD y comprobantes manuales se conservan estrictos.',
      })
      const report = await checkLedger()
      const expectedRevenue = money(
        products.reduce(
          (sum, product, index) =>
            sum + money(product.prices.USD * (1 + (index % 4)) * rate),
          0,
        ) + money(gross * rate),
      )
      eq(credit(report, '4110'), expectedRevenue)
      eq(
        (await currentDay()).report.expectedUsd,
        money(100 + Number(cash.total)),
      )
    },
  )

  await scenario(
    'Liquidación USD admite redondeo positivo, negativo y cero sin alterar importes originales',
    async () => {
      const product = products[0]
      for (const [gross, expectedDelta] of [
        [0.12, -0.01],
        [0.11, 0],
        [0.01, 0],
        [6, 0.01],
        [100, 0],
      ]) {
        await owner(
          "update public.product_prices set amount=$2 where product_id=$1 and tier_code='emprendedor' and currency='USD'",
          [product.id, gross],
        )
        const sold = await call(
          'create_document',
          invoice(
            {
              currency: 'USD',
              paymentMethod: 'card_pos',
              expectedTotal: gross,
              items: [
                {
                  productId: product.id,
                  quantity: 1,
                  expectedUnitPrice: gross,
                },
              ],
            },
            1,
          ),
        )
        eq(Number(sold.total), gross)
        const fee = money((gross * 4.5) / 100)
        const withheld = money((gross * 1.5) / 100)
        const net = money(gross - fee - withheld)
        const lines = [
          { account: '1120-002', debit: net, credit: 0 },
          { account: '5140-001', debit: fee, credit: 0 },
          { account: '1340', debit: withheld, credit: 0 },
          { account: '1142', debit: 0, credit: gross },
        ].filter((line) => line.debit > 0 || line.credit > 0)
        const delta = money(
          money(gross * rate) -
            lines.reduce((sum, line) => sum + money(line.debit * rate), 0),
        )
        eq(delta, expectedDelta)
        const input = voucher(lines, {
          kind: 'card_settlement',
          currency: 'USD',
          exchangeRate: rate,
          gross,
          commissionRate: 4.5,
          withholdingRate: 1.5,
          withholdingBase: 'gross',
          bankAccount: '1120-002',
        })
        const id = await call('record_journal_entry', input)
        const stored = await query(
          'select * from public.journal_lines where entry_id=$1 order by line_no',
          [id],
        )
        for (let index = 0; index < lines.length; index++) {
          eq(Number(stored[index].debit), lines[index].debit)
          eq(Number(stored[index].credit), lines[index].credit)
          eq(
            Number(stored[index].debit_nio),
            money(money(lines[index].debit * rate) + (index === 0 ? delta : 0)),
          )
          eq(
            Number(stored[index].credit_nio),
            money(lines[index].credit * rate),
          )
        }
        const report = await checkLedger()
        eq(
          report.accounts.find((a) => a.code === '1142').closing,
          0,
          'Cada liquidación salda sólo su venta POS',
        )
      }
    },
  )

  await scenario(
    'Respuesta perdida y cierre diario no duplican ni reescriben operaciones',
    async () => {
      const input = invoice({}, 100)
      const document = await call('create_document', input)
      const purchaseInput = shipment()
      const purchaseId = await call('record_shipment', purchaseInput)
      const { input: closeInput, result: frozen } = await close()
      const before = await snapshot()
      await clock(nextDay)
      eq(await call('create_document', input), document)
      eq(await call('record_shipment', purchaseInput), purchaseId)
      const closed = await call('close_business_day', closeInput)
      eq(closed.report, frozen.report, 'El reporte cerrado permanece inmutable')
      eq(
        await snapshot(),
        before,
        'Los reintentos al día siguiente sólo recuperan resultados',
      )
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: frozen.report.countedNio,
        openingUsd: frozen.report.countedUsd,
      })
      await rejected(
        'anular factura del cierre anterior',
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            document.id,
            'Cambio de cliente posterior al cierre',
          ]),
        /cerrada/,
      )
      await rejected(
        'editar factura emitida directamente',
        () =>
          db.query(
            "update public.documents set customer_name='Otro' where id=$1",
            [document.id],
          ),
        /permission denied/,
      )
      const old = (
        await query('select public.get_business_day($1) r', [day])
      )[0].r
      eq(old.report, frozen.report)
      await checkLedger(nextDay)
    },
  )

  await scenario(
    'Sin costo conocido se rechaza toda la factura; proforma y costo cero siguen válidos',
    async () => {
      await owner('delete from public.product_costs where product_id=$1', [
        products.at(-1).id,
      ])
      const input = invoice({}, 100)
      const expected =
        /Falta registrar el costo.*QA-INT-100.*administrador.*Inventario.*Editar.*Costo de inventario/s
      await rejected(
        'costo desconocido en último producto de cien',
        () => call('create_document', input),
        expected,
      )
      await identity(db, operator)
      await rejected(
        'Caja recibe pasos para resolver y no el importe del costo',
        () => call('create_document', input),
        expected,
      )
      await identity(db, admin)
      const quote = await call('create_document', {
        ...input,
        requestId: crypto.randomUUID(),
        kind: 'proforma',
        validUntil: day,
      })
      eq(quote.items.length, 100)
      eq(
        (
          await query('select count(*)::int n from public.document_item_costs')
        )[0].n,
        0,
        'Proforma sin efectos contables',
      )
      await owner(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,0)',
        [products.at(-1).id],
      )
      const document = await call('create_document', input)
      eq(document.number, 'FAC-000001')
      const zero = (
        await query(
          'select unit_cost_nio from public.document_item_costs where document_id=$1 and product_id=$2',
          [document.id, products.at(-1).id],
        )
      )[0]
      eq(
        Number(zero.unit_cost_nio),
        0,
        'Cero es costo conocido; no se confunde con ausencia',
      )
      await checkLedger()
      findings.push({
        severity: 'high',
        status: 'fixed',
        key: 'invoice_missing_initial_cost',
        reproduction:
          'Perfume con conteo mayor a cero y sin costo inicial; emitir factura.',
        actual:
          'Antes se congelaba costo NULL y la contabilidad nueva quedaba pendiente.',
        resolution:
          'PostgreSQL impide la venta nueva e indica el perfume y el paso Inventario → Editar → Costo de inventario. La operación completa revierte; se puede volver a emitir tras registrar el costo.',
      })
    },
  )

  await scenario(
    'Salidas, daños y ajustes sin costo se rechazan sin escrituras parciales',
    async () => {
      const product = products[0]
      await owner('delete from public.product_costs where product_id=$1', [
        product.id,
      ])
      const movements = ['EXIT', 'DAMAGED', 'ADJUSTMENT', 'ADJUSTMENT'].map(
        (type, index) => ({
          requestId: crypto.randomUUID(),
          productId: product.id,
          location: 'store',
          type,
          quantity: type === 'ADJUSTMENT' ? (index === 3 ? 210 : 190) : 1,
          note: 'Registro aislado de movimiento',
        }),
      )
      for (const input of movements)
        await rejected(
          `sin costo: ${input.type}`,
          () => call('record_inventory_movement', input),
          /Falta registrar el costo.*administrador.*Inventario.*Editar/s,
        )
      await owner(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
        [product.id],
      )
      for (const input of movements) {
        const id = await call('record_inventory_movement', input)
        eq(
          await call('record_inventory_movement', input),
          id,
          'Reintentar movimiento no repite merma',
        )
      }
      eq(
        (
          await query(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [product.id],
          )
        )[0].quantity,
        210,
      )
      const report = await checkLedger()
      eq(debit(report, '5150'), 1000)
      eq(credit(report, '4190'), 2000)
      eq(
        (
          await query(
            'select count(*)::int n from public.inventory_movement_costs',
          )
        )[0].n,
        3,
      )
    },
  )

  await scenario(
    'El conteo inicial y la entrada sin costo conservan su uso sin generar costos inventados',
    async () => {
      const product = products[0]
      await owner('delete from public.product_costs where product_id=$1', [
        product.id,
      ])
      await owner(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='store'",
        [product.id],
      )
      const count = {
        requestId: crypto.randomUUID(),
        productId: product.id,
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 0,
        note: 'Conteo inicial sin existencias',
      }
      const id = await call('record_inventory_movement', count)
      eq(await call('record_inventory_movement', count), id)
      await call('record_inventory_movement', {
        ...count,
        requestId: crypto.randomUUID(),
        type: 'ENTRY',
        quantity: 5,
        note: 'Existencias antes de cargar el costo inicial',
      })
      eq(
        (
          await query(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [product.id],
          )
        )[0].quantity,
        5,
      )
      eq((await ledger()).missingCosts, 0)
    },
  )

  await scenario(
    'Facturas históricas incompletas conservan sus snapshots y reintentos originales',
    async () => {
      const input = invoice({}, 1)
      const document = await call('create_document', input)
      // Seed propietario: reproduce una venta existente anterior a la guardia,
      // sin introducir un bypass disponible a usuarios o funciones de negocio.
      await owner(
        'update public.document_item_costs set unit_cost_nio=null where document_id=$1',
        [document.id],
      )
      await owner('delete from public.product_costs where product_id=$1', [
        products[0].id,
      ])
      const costs = await query(
        'select unit_cost_nio from public.document_item_costs where document_id=$1',
        [document.id],
      )
      eq(costs[0].unit_cost_nio, null)
      const report = await ledger()
      eq(report.missingCosts, 1)
      const model = journalModel(report, 'Empresa QA')
      eq(
        model.income.at(-1).periodNio,
        null,
        'No se presenta una utilidad inventada',
      )
      await owner(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
        [products[0].id],
      )
      eq(
        (await ledger()).missingCosts,
        1,
        'Registrar costo después no completa automáticamente el histórico',
      )
      const storedPayload = (
        await owner(
          'select request_payload from public.documents where id=$1',
          [document.id],
        )
      )[0].request_payload
      eq(await call('create_document', storedPayload), document)
      eq(input.requestId, document.request_id)
    },
  )

  await scenario(
    'Una compra equivocada no puede deshacerse mediante un simple ajuste de inventario',
    async () => {
      const product = products[0]
      const id = await call(
        'record_shipment',
        shipment({
          lines: [
            {
              productId: product.id,
              location: 'store',
              quantity: 100,
              unitPrice: 150,
            },
          ],
        }),
      )
      const original = (
        await query('select * from public.purchase_shipments where id=$1', [id])
      )[0]
      await rejected(
        'compra guardada no admite editar la tabla directamente',
        () =>
          db.query(
            'update public.purchase_shipments set goods_amount=1500 where id=$1',
            [id],
          ),
        /permission denied/,
      )
      eq(
        (
          await owner(
            "select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('void_purchase','void_shipment','cancel_shipment','update_shipment','delete_shipment','reverse_shipment','correct_purchase')",
          )
        )[0].n,
        0,
      )
      const report = await checkLedger()
      eq(credit(report, '2111'), 15100)
      const cost = Number(
        (
          await query(
            'select average_cost_nio from public.product_costs where product_id=$1',
            [product.id],
          )
        )[0].average_cost_nio,
      )
      await call('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product.id,
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 210,
        note: 'Intento de corregir cien unidades cuando debían ser diez',
      })
      const after = await checkLedger()
      eq(
        credit(after, '2111'),
        15100,
        'El ajuste de unidades no revierte la deuda de compra equivocada',
      )
      eq(
        debit(after, '5150'),
        money(90 * cost),
        'El ajuste se registra como pérdida, no corrección de la compra',
      )
      eq(
        (
          await query('select * from public.purchase_shipments where id=$1', [
            id,
          ])
        )[0],
        original,
      )
      findings.push({
        severity: 'high',
        status: 'open',
        key: 'purchase_correction_unavailable',
        reproduction:
          'Registrar 100 unidades cuando llegaron 10; intentar corregir compra o usar Ajuste para restar 90.',
        actual:
          'No hay edición/anulación de compras. El ajuste sólo reduce inventario y registra pérdida; la deuda, compra y costo promedio originales permanecen.',
        proposed:
          'Agregar reversión/corrección auditada de compras con restricciones para ventas, pagos y jornadas cerradas posteriores. No corregir sólo unidades ni borrar la compra.',
      })
    },
  )

  await mkdir('output/enterprise-integrity', { recursive: true })
  const result = {
    checks,
    scenarios,
    findings,
    products: products.length,
    productionWrites: 0,
    durationMs: Math.round(performance.now() - started),
  }
  await writeFile(
    'output/enterprise-integrity/result.json',
    JSON.stringify(result, null, 2),
  )
  console.log(
    `PASS integridad empresarial: ${checks} comprobaciones; ${scenarios.length} escenarios; ${findings.length} hallazgos; sin producción.`,
  )
} finally {
  await server?.close()
  await db.close()
}
