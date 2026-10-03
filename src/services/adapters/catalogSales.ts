import type { Currency, PaymentMethod, PriceTier } from '../../lib/domain'
import { catalogProducts } from './catalog'
import type {
  AccountingSource,
  ExpenseCategory,
  ExpenseRecord,
  ShipmentRecord,
  SaleCostSnapshot,
} from '../../features/reports/accounting'
import {
  financeLedger,
  isMoneyAccount,
  reducesLoan,
  salesByPayment,
  type CreditAccount,
  type CreditLedger,
  type FinanceAccount,
  type FinanceEntryRecord,
  type FinanceKind,
  type FinanceLedger,
} from '../../features/accounting/finance'
import {
  cashflowTotals,
  type CashflowReport,
  type CashflowRow,
} from '../../features/accounting/cashflow'
import {
  addDays,
  localDay,
  type ReportRange,
  type ReportCustomer,
  type ReportDocument,
  type ReportMovement,
} from '../../features/reports/model'

// Ventas inventadas para la vista local: sin ellas los reportes de la
// demostración saldrían vacíos y no habría forma de revisar los gráficos ni de
// probarlos. Todo se genera con una secuencia fija, así que dos ejecuciones dan
// exactamente las mismas cifras y las pruebas no dependen del azar.

/** Generador congruencial: reproducible y suficiente para datos de muestra. */
function sequence(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const payments: (PaymentMethod | 'pending')[] = [
  'cash',
  'cash',
  'card_pos',
  'bank_transfer',
  'pending',
]
const tiers: PriceTier[] = ['emprendedor', 'emprendedor', 'vip', 'premium']
const names = [
  'Perfumería El Rosal',
  'Distribuidora Lía',
  'Boutique Aroma',
  'Karla Méndez',
  'Tienda Girasol',
  'Mayoreo Estelí',
  'Ana Sofía Ruiz',
  'Comercial Bendición',
  'Variedades Nuevo Día',
  'Jorge Martínez',
]

interface SyntheticSales {
  documents: ReportDocument[]
  customers: ReportCustomer[]
  movements: ReportMovement[]
  accounting: AccountingSource
}

/** Tasa fija de muestra: la vista local no consulta ningún tipo de cambio real. */
const DEMO_RATE = 36.6
const round = (value: number) => Math.round(value * 100) / 100
/**
 * Costo promedio inventado por producto, entre el 52 % y el 82 % de su precio
 * Emprendedor. El tramo alto deja a propósito algún perfume por debajo del
 * precio Premium: es el caso que el panel debe saber señalar.
 */
export const demoAverageCost = new Map(
  catalogProducts.map((product, index) => [
    product.id,
    round(
      (product.prices?.emprendedor.NIO ?? product.price) *
        (0.52 + (index % 11) * 0.03),
    ),
  ]),
)

/** Un año de ventas de muestra terminando en `today`. */
export function syntheticSales(today = localDay(new Date())): SyntheticSales {
  const random = sequence(20260914)
  const customers: ReportCustomer[] = names.map((name, index) => ({
    id: `demo-cliente-${index + 1}`,
    name,
    // Los últimos tres se registran dentro del último mes: así el reporte
    // distingue clientes nuevos de recurrentes.
    createdAt: `${addDays(today, index >= names.length - 3 ? -12 - index : -200 - index * 9)}T15:00:00Z`,
  }))
  const documents: ReportDocument[] = []
  const movements: ReportMovement[] = []
  const saleCosts: SaleCostSnapshot[] = []
  const shipments: ShipmentRecord[] = []
  const expenses: ExpenseRecord[] = []
  const movementCosts: NonNullable<AccountingSource['movementCosts']> = []
  let invoice = 0
  let proforma = 0

  for (let back = 364; back >= 0; back--) {
    const day = addDays(today, -back)
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    // Domingo cierra; el fin de semana vende más que el resto.
    if (weekday === 0) continue
    const base = weekday === 6 || weekday === 5 ? 3 : 2
    // Una tendencia suave hacia el presente hace legible el gráfico de ingresos.
    const growth = 1 + (364 - back) / 900
    const count = Math.round((base + random() * 2) * growth)

    for (let n = 0; n < count; n++) {
      const currency: Currency = random() < 0.18 ? 'USD' : 'NIO'
      const tier = tiers[Math.floor(random() * tiers.length)]
      const customer = customers[Math.floor(random() * customers.length)]
      const lines = 1 + Math.floor(random() * 3)
      const items = []
      let total = 0
      const used = new Set<string>()
      for (let line = 0; line < lines; line++) {
        // Los primeros del catálogo salen más: da un ranking con relieve.
        const pick = Math.floor(
          Math.pow(random(), 1.9) * catalogProducts.length,
        )
        const product = catalogProducts[pick]
        if (used.has(product.id)) continue
        used.add(product.id)
        const quantity = 1 + Math.floor(random() * 4)
        const unit = product.prices?.[tier][currency] ?? 0
        const lineTotal = Math.round(unit * quantity * 100) / 100
        total += lineTotal
        items.push({
          productId: product.id,
          description: `${product.brand} · ${product.name}`,
          quantity,
          lineTotal,
        })
        movements.push({
          productId: product.id,
          type: 'SALE',
          quantity,
          createdAt: `${day}T19:00:00Z`,
        })
      }
      if (!items.length) continue
      const kind = random() < 0.16 ? 'proforma' : 'invoice'
      const number =
        kind === 'invoice'
          ? `FAC-${String(++invoice).padStart(6, '0')}`
          : `PRO-${String(++proforma).padStart(6, '0')}`
      const id = `${day}-${n}`
      // El costo de una venta se congela al emitir: aquí se imita esa foto con
      // una pequeña deriva histórica, para que el margen no salga siempre igual.
      if (kind === 'invoice')
        for (const item of items) {
          const average = demoAverageCost.get(item.productId) ?? 0
          saleCosts.push({
            documentId: id,
            productId: item.productId,
            quantity: item.quantity,
            unitCostNio: round(average * (0.88 + (back % 9) * 0.03)),
            netRevenueNio: round(
              item.lineTotal * (currency === 'USD' ? DEMO_RATE : 1),
            ),
            taxNio: 0,
          })
        }
      documents.push({
        id,
        kind,
        number,
        createdAt: `${day}T${String(14 + (n % 5)).padStart(2, '0')}:30:00Z`,
        currency,
        total: Math.round(total * 100) / 100,
        tier,
        paymentMethod:
          kind === 'invoice'
            ? payments[Math.floor(random() * payments.length)]
            : null,
        location: kind === 'invoice' ? 'store' : null,
        customerId: customer.id,
        customerName: customer.name,
        items,
      })
    }
    // Alguna merma y alguna entrada sueltas para el resumen de movimientos.
    if (random() < 0.08) {
      const product = catalogProducts[Math.floor(random() * 20)]
      const at = `${day}T20:00:00Z`
      movements.push({
        id: `merma-${day}`,
        productId: product.id,
        type: 'DAMAGED',
        quantity: 1,
        createdAt: at,
      })
      movementCosts.push({
        movementId: `merma-${day}`,
        productId: product.id,
        type: 'DAMAGED',
        quantity: 1,
        unitCostNio: demoAverageCost.get(product.id) ?? null,
        createdAt: at,
      })
    }
    if (random() < 0.12) {
      // Un pedido de muestra es una caja con varios perfumes: la agencia cobra
      // una sola vez, por el peso del paquete, y ese cobro se reparte por igual
      // entre las unidades que venían dentro.
      const picked: {
        productId: string
        quantity: number
        unitPrice: number
      }[] = []
      const chosen = new Set<string>()
      for (let line = 0; line < 2 + Math.floor(random() * 3); line++) {
        const product = catalogProducts[Math.floor(random() * 20)]
        if (chosen.has(product.id)) continue
        chosen.add(product.id)
        picked.push({
          productId: product.id,
          quantity: 4 + Math.floor(random() * 12),
          unitPrice: round((demoAverageCost.get(product.id) ?? 0) * 0.88),
        })
      }
      const units = picked.reduce((sum, line) => sum + line.quantity, 0)
      const shippingAmount = round(units * (9 + random() * 5))
      const shippingPerUnit = Math.round((shippingAmount / units) * 1e6) / 1e6
      for (const line of picked)
        movements.push({
          id: `entrada-${day}-${line.productId}`,
          productId: line.productId,
          type: 'ENTRY',
          quantity: line.quantity,
          createdAt: `${day}T09:00:00Z`,
        })
      shipments.push({
        id: `pedido-${day}`,
        requestId: `pedido-${day}`,
        incurredOn: day,
        createdAt: `${day}T09:00:00Z`,
        supplier: [
          'Importadora del Golfo',
          'Perfumes de Oriente',
          'Distribuidora Central',
        ][Math.floor(random() * 3)],
        agency: ['Aeropaq', 'Cargo Express', 'Trans-Express'][
          Math.floor(random() * 3)
        ],
        reference: `PED-${day.replace(/-/g, '')}`,
        note: 'Pedido de muestra',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount,
        goodsAmount: round(
          picked.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
        ),
        units,
        shippingPerUnit,
        lines: picked.map((line) => ({
          id: `pedido-${day}-${line.productId}`,
          productId: line.productId,
          location: 'warehouse' as const,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          goodsAmount: round(line.quantity * line.unitPrice),
          shippingShare:
            Math.round(line.quantity * shippingPerUnit * 1e6) / 1e6,
          landedUnitCostNio:
            Math.round((line.unitPrice + shippingPerUnit) * 1e6) / 1e6,
        })),
      })
    }
    // Los gastos fijos se registran el primero de cada mes.
    if (day.endsWith('-01'))
      expenses.push(
        ...(
          [
            ['renta', 'Alquiler del local', 14000],
            ['salario', 'Planilla del mes', 21500],
            ['agua_luz', 'Energía y agua', 3100],
            ['internet', 'Servicio de internet', 1200],
            ['marketing', 'Pauta en redes sociales', 2600],
            ['combustible', 'Combustible de entregas', 1450],
            ['papeleria', 'Papelería y facturas', 620],
            ['limpieza', 'Artículos de limpieza', 480],
            ['viatico', 'Viáticos de la ruta', 900],
            ['impuestos_dgi', 'Anticipo mensual DGI', 3800],
            ['impuestos_alma', 'Matrícula y basura ALMA', 1100],
            ['interes_bancario', 'Intereses del préstamo', 2450],
            ['prestamo_bancario', 'Cuota de capital del préstamo', 7800],
          ] as [ExpenseCategory, string, number][]
        ).map(([category, description, amount], index) => ({
          id: `gasto-${day}-${index}`,
          requestId: `gasto-${day}-${index}`,
          incurredOn: day,
          createdAt: `${day}T08:00:00Z`,
          category,
          description,
          amount,
          currency: 'NIO' as const,
          exchangeRate: 1,
          reference: `CMP-${day.replace(/-/g, '')}-${index}`,
          voidedAt: null,
          voidReason: null,
        })),
      )
  }
  return {
    documents,
    customers,
    movements,
    accounting: {
      available: true,
      truncated: false,
      costs: catalogProducts.map((product) => ({
        productId: product.id,
        averageCostNio: demoAverageCost.get(product.id) ?? null,
        updatedAt: `${today}T09:00:00Z`,
      })),
      shipments,
      expenses,
      saleCosts,
      movementCosts,
    },
  }
}

/**
 * Caja, bancos y deudas de muestra sobre el mismo año de ventas: saldos
 * iniciales el primer día, un préstamo, y cada mes una transferencia a banco,
 * un cobro, un pago al proveedor y un retiro del dueño. La renta, la planilla
 * y el préstamo se pagan desde el banco; lo demás, de caja. Uno de cada tres
 * pedidos queda a crédito del proveedor.
 */
function syntheticCreditRows(sales: SyntheticSales): CreditAccount[] {
  return [
    ...sales.documents
      .filter(
        (row) => row.kind === 'invoice' && row.paymentMethod === 'pending',
      )
      .map((row): CreditAccount => {
        const amount = round(
          row.total * (row.currency === 'USD' ? DEMO_RATE : 1),
        )
        return {
          id: `invoice:${row.id}`,
          kind: 'receivable',
          counterparty: row.customerName,
          reference: row.number,
          occurredOn: localDay(row.createdAt),
          originalNio: amount,
          paidNio: 0,
          balanceNio: amount,
          documentId: row.id,
          shipmentId: null,
        }
      }),
    ...sales.accounting.shipments
      .filter((_, index) => index % 3 === 0)
      .map((row): CreditAccount => {
        const amount =
          round(row.goodsAmount * row.exchangeRate) +
          round(row.shippingAmount * row.exchangeRate)
        return {
          id: `shipment:${row.id}`,
          kind: 'payable',
          counterparty: row.supplier,
          reference: row.reference,
          occurredOn: row.incurredOn,
          originalNio: amount,
          paidNio: 0,
          balanceNio: amount,
          documentId: null,
          shipmentId: row.id,
        }
      }),
  ].sort(
    (a, b) =>
      a.occurredOn.localeCompare(b.occurredOn) || a.id.localeCompare(b.id),
  )
}

/** En la muestra cada abono identifica la factura o el pedido que liquida. */
function syntheticEntries(
  sales: SyntheticSales,
  today: string,
): FinanceEntryRecord[] {
  const start = addDays(today, -364)
  const entries: FinanceEntryRecord[] = []
  const entry = (
    occurredOn: string,
    kind: FinanceKind,
    account: FinanceAccount,
    amount: number,
    description: string,
    changes: Partial<FinanceEntryRecord> = {},
  ) =>
    entries.push({
      id: `mov-${entries.length + 1}`,
      requestId: `mov-${entries.length + 1}`,
      occurredOn,
      kind,
      account,
      toAccount: null,
      amount,
      currency: 'NIO',
      exchangeRate: 1,
      counterparty: '',
      description,
      reference: '',
      createdAt: `${occurredOn}T08:00:00Z`,
      voidedAt: null,
      voidReason: null,
      ...changes,
    })
  entry(start, 'opening', 'caja', 45000, 'Arqueo de apertura')
  entry(start, 'opening', 'banco', 320000, 'Estado de cuenta de apertura')
  entry(start, 'opening', 'cobrar', 0, 'Sin saldos de clientes al iniciar')
  entry(
    start,
    'opening',
    'proveedores',
    0,
    'Sin saldos de proveedores al iniciar',
  )
  entry(start, 'opening', 'prestamos', 280000, 'Saldo del préstamo bancario', {
    counterparty: 'Banco de muestra',
  })
  entry(
    addDays(start, 40),
    'loan',
    'banco',
    150000,
    'Préstamo para inventario',
    { counterparty: 'Banco de muestra' },
  )
  const debts = syntheticCreditRows(sales)
  const pay = (
    day: string,
    kind: 'collection' | 'supplier_payment',
    budget: number,
  ) => {
    const type = kind === 'collection' ? 'receivable' : 'payable'
    for (const debt of debts) {
      if (budget <= 0) break
      if (debt.kind !== type || debt.occurredOn > day || !debt.balanceNio)
        continue
      const amount = Math.min(budget, debt.balanceNio)
      entry(day, kind, 'banco', amount, `Abono a ${debt.reference}`, {
        counterparty: debt.counterparty,
        reference: debt.reference,
        documentId: debt.documentId,
        shipmentId: debt.shipmentId,
      })
      debt.balanceNio = round(debt.balanceNio - amount)
      budget = round(budget - amount)
    }
  }
  for (let back = 360; back >= 0; back--) {
    const day = addDays(today, -back)
    if (day.endsWith('-05'))
      entry(day, 'transfer', 'caja', 90000, 'Depósito de ventas en efectivo', {
        toAccount: 'banco',
      })
    if (day.endsWith('-15')) {
      pay(day, 'collection', 85000)
      pay(day, 'supplier_payment', 15000)
    }
    if (day.endsWith('-28'))
      entry(day, 'withdrawal', 'caja', 18000, 'Retiro del dueño')
  }
  return entries
}

export function syntheticCredits(
  at: string,
  today = localDay(new Date()),
): CreditLedger {
  const sales = syntheticSales(today)
  const entries = syntheticEntries(sales, today).filter(
    (row) => row.occurredOn <= at,
  )
  const rows = syntheticCreditRows(sales).filter((row) => row.occurredOn <= at)
  for (const debt of rows) {
    const paid = round(
      entries
        .filter((entry) =>
          debt.documentId
            ? entry.documentId === debt.documentId
            : entry.shipmentId === debt.shipmentId,
        )
        .reduce((sum, entry) => sum + entry.amount * entry.exchangeRate, 0),
    )
    debt.paidNio = paid
    debt.balanceNio = round((debt.originalNio ?? 0) - paid)
  }
  const start = addDays(today, -364)
  return {
    available: true,
    at,
    startOn: at >= start ? start : null,
    rows,
    unallocatedNio: { receivables: 0, payables: 0 },
    legacyPayments: 0,
  }
}

export function syntheticFinance(
  range: ReportRange,
  today = localDay(new Date()),
): FinanceLedger {
  const sales = syntheticSales(today)
  return syntheticFinanceOf(sales, syntheticEntries(sales, today), range, today)
}

function syntheticFinanceOf(
  sales: SyntheticSales,
  entries: FinanceEntryRecord[],
  range: ReportRange,
  today: string,
): FinanceLedger {
  const start = addDays(today, -364)
  const bank = new Set<ExpenseCategory>([
    'renta',
    'salario',
    'prestamo_bancario',
    'interes_bancario',
  ])
  return financeLedger(
    {
      entries,
      expenses: sales.accounting.expenses.map((row) => ({
        ...row,
        account: bank.has(row.category) ? 'banco' : 'caja',
      })),
      shipments: sales.accounting.shipments.map((row, index) => ({
        incurredOn: row.incurredOn,
        account: index % 3 === 0 ? 'credito' : 'banco',
        amountNio:
          round(row.goodsAmount * row.exchangeRate) +
          round(row.shippingAmount * row.exchangeRate),
      })),
      sales: salesByPayment(
        sales.documents
          .filter((row) => row.kind === 'invoice')
          .filter((row) => {
            const day = row.createdAt.slice(0, 10)
            return day >= start && day <= range.to
          })
          .map((row) => ({
            paymentMethod: row.paymentMethod ?? null,
            amountNio: round(
              row.total * (row.currency === 'USD' ? DEMO_RATE : 1),
            ),
          })),
      ),
    },
    range,
  )
}

/** El mismo dinero de la muestra de créditos y estados, agrupado por día. */
export function syntheticCashflow(
  range: ReportRange,
  today = localDay(new Date()),
): CashflowReport {
  const sales = syntheticSales(today)
  const entries = syntheticEntries(sales, today)
  const groups = new Map<string, CashflowRow>()
  const add = (
    day: string,
    account: CashflowRow['account'],
    category: CashflowRow['category'],
    inflowNio: number,
    outflowNio: number,
  ) => {
    if (day < range.from || day > range.to) return
    const key = `${day}:${account}:${category}`
    const row = groups.get(key) ?? {
      day,
      account,
      category,
      inflowNio: 0,
      outflowNio: 0,
      operations: 0,
      missingSales: 0,
    }
    row.inflowNio = round(row.inflowNio + inflowNio)
    row.outflowNio = round(row.outflowNio + outflowNio)
    row.operations++
    groups.set(key, row)
  }
  for (const invoice of sales.documents) {
    if (invoice.kind !== 'invoice' || invoice.paymentMethod === 'pending')
      continue
    add(
      localDay(invoice.createdAt),
      invoice.paymentMethod === 'cash' ? 'caja' : 'banco',
      'sales',
      round(invoice.total * (invoice.currency === 'USD' ? DEMO_RATE : 1)),
      0,
    )
  }
  for (const entry of entries) {
    if (!isMoneyAccount(entry.account)) continue
    const amount = round(entry.amount * entry.exchangeRate)
    if (entry.kind === 'transfer' && entry.toAccount) {
      add(entry.occurredOn, entry.account, 'transfer', 0, amount)
      add(entry.occurredOn, entry.toAccount, 'transfer', amount, 0)
    } else {
      const outgoing =
        entry.kind === 'withdrawal' || entry.kind === 'supplier_payment'
      add(
        entry.occurredOn,
        entry.account,
        entry.kind,
        outgoing ? 0 : amount,
        outgoing ? amount : 0,
      )
    }
  }
  for (const [index, shipment] of sales.accounting.shipments.entries()) {
    if (index % 3 === 0) continue
    add(
      shipment.incurredOn,
      'banco',
      'purchases',
      0,
      round(shipment.goodsAmount * shipment.exchangeRate) +
        round(shipment.shippingAmount * shipment.exchangeRate),
    )
  }
  const bank = new Set<ExpenseCategory>([
    'renta',
    'salario',
    'prestamo_bancario',
    'interes_bancario',
  ])
  for (const expense of sales.accounting.expenses) {
    if (expense.voidedAt) continue
    add(
      expense.incurredOn,
      bank.has(expense.category) ? 'banco' : 'caja',
      reducesLoan(expense) ? 'loan_payment' : 'expense',
      0,
      round(expense.amount * expense.exchangeRate),
    )
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      a.account.localeCompare(b.account) ||
      a.category.localeCompare(b.category),
  )
  const prior = syntheticFinanceOf(
    sales,
    entries,
    { from: range.from, to: addDays(range.from, -1) },
    today,
  ).position
  const current = syntheticFinanceOf(sales, entries, range, today).position
  return {
    available: true,
    ...range,
    startOn: current.startOn,
    opening: prior.started ? prior.cash : { caja: null, banco: null },
    closing: current.started ? current.cash : { caja: null, banco: null },
    missingSales: 0,
    rows,
    totals: cashflowTotals(rows),
  }
}
