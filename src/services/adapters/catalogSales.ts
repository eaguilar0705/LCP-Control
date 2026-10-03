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
  salesByPayment,
  type FinanceAccount,
  type FinanceEntryRecord,
  type FinanceKind,
  type FinanceLedger,
} from '../../features/accounting/finance'
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
    round((product.prices?.emprendedor.NIO ?? product.price) * (0.52 + (index % 11) * 0.03)),
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
            netRevenueNio: round(item.lineTotal * (currency === 'USD' ? DEMO_RATE : 1)),
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
      const picked: { productId: string; quantity: number; unitPrice: number }[] = []
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
        supplier: ['Importadora del Golfo', 'Perfumes de Oriente', 'Distribuidora Central'][
          Math.floor(random() * 3)
        ],
        agency: ['Aeropaq', 'Cargo Express', 'Trans-Express'][Math.floor(random() * 3)],
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
          shippingShare: Math.round(line.quantity * shippingPerUnit * 1e6) / 1e6,
          landedUnitCostNio:
            Math.round((line.unitPrice + shippingPerUnit) * 1e6) / 1e6,
        })),
      })
    }
    // Los gastos fijos se registran el primero de cada mes.
    if (day.endsWith('-01'))
      expenses.push(
        ...([
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
export function syntheticFinance(range: ReportRange, today = localDay(new Date())): FinanceLedger {
  const sales = syntheticSales(today)
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
  entry(start, 'opening', 'prestamos', 280000, 'Saldo del préstamo bancario', { counterparty: 'Banco de muestra' })
  entry(addDays(start, 40), 'loan', 'banco', 150000, 'Préstamo para inventario', { counterparty: 'Banco de muestra' })
  for (let back = 360; back >= 0; back--) {
    const day = addDays(today, -back)
    if (day.endsWith('-05'))
      entry(day, 'transfer', 'caja', 90000, 'Depósito de ventas en efectivo', { toAccount: 'banco' })
    if (day.endsWith('-15')) {
      entry(day, 'collection', 'banco', 85000, 'Cobro de facturas pendientes', { counterparty: 'Clientes varios' })
      entry(day, 'supplier_payment', 'banco', 15000, 'Abono al proveedor', { counterparty: 'Importadora del Golfo' })
    }
    if (day.endsWith('-28'))
      entry(day, 'withdrawal', 'caja', 18000, 'Retiro del dueño')
  }
  const bank = new Set<ExpenseCategory>(['renta', 'salario', 'prestamo_bancario', 'interes_bancario'])
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
        amountNio: round(row.goodsAmount * row.exchangeRate) + round(row.shippingAmount * row.exchangeRate),
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
            amountNio: round(row.total * (row.currency === 'USD' ? DEMO_RATE : 1)),
          })),
      ),
    },
    range,
  )
}
