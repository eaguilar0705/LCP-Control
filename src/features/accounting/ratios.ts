import {
  inventoryTurnover,
  roundMoney,
  type accountingSummary,
} from '../reports/accounting'
import { daysBetween, type ReportRange } from '../reports/model'
import type { FinancePosition } from './finance'

type AccountingSummary = ReturnType<typeof accountingSummary>

/**
 * Razones financieras del período con las mismas cifras de los estados: el
 * resultado sale de `accountingSummary` y el balance de `FinancePosition`.
 * Una razón queda en `null` cuando falta uno de sus dos lados; nunca se
 * divide entre cero ni entre una cifra incompleta.
 */
export interface Ratio {
  key: string
  label: string
  value: number | null
  format: 'times' | 'percent' | 'money' | 'days'
  /** Fórmula corta para el rótulo. */
  formula: string
}
export interface RatioGroup {
  key: string
  label: string
  ratios: Ratio[]
}

const divide = (top: number | null, bottom: number | null) =>
  top === null || bottom === null || bottom <= 0 ? null : top / bottom

export function financialRatios(
  summary: AccountingSummary,
  position: FinancePosition,
  range: ReportRange,
): RatioGroup[] {
  const started = position.started
  const days = Math.max(1, daysBetween(range.from, range.to) + 1)
  const cash = started ? position.cash.caja + position.cash.banco : null
  const receivables = started ? position.receivablesNio : null
  const inventory = summary.unvaluedProducts ? null : summary.inventoryCostNio
  const current =
    cash === null || receivables === null || inventory === null
      ? null
      : cash + receivables + inventory
  const liabilities = started ? position.loansNio + position.payablesNio : null
  const equity =
    current === null || liabilities === null ? null : current - liabilities
  const revenue = summary.revenueNio > 0 ? summary.revenueNio : null
  const turnover = inventoryTurnover(summary, range)
  const perDay = (amount: number | null) =>
    amount === null ? null : amount / days
  return [
    {
      key: 'liquidity',
      label: 'Liquidez',
      ratios: [
        {
          key: 'current',
          label: 'Razón corriente',
          value: divide(current, liabilities),
          format: 'times',
          formula: 'Activo corriente ÷ pasivo corriente',
        },
        {
          key: 'quick',
          label: 'Prueba ácida',
          value: divide(
            current === null || inventory === null ? null : current - inventory,
            liabilities,
          ),
          format: 'times',
          formula: '(Activo corriente − inventario) ÷ pasivo corriente',
        },
        {
          key: 'cash',
          label: 'Razón de efectivo',
          value: divide(cash, liabilities),
          format: 'times',
          formula: 'Caja y bancos ÷ pasivo corriente',
        },
        {
          key: 'workingCapital',
          label: 'Capital de trabajo',
          value:
            current === null || liabilities === null
              ? null
              : roundMoney(current - liabilities),
          format: 'money',
          formula: 'Activo corriente − pasivo corriente',
        },
      ],
    },
    {
      key: 'debt',
      label: 'Endeudamiento',
      ratios: [
        {
          key: 'debtRatio',
          label: 'Endeudamiento',
          value: divide(liabilities, current),
          format: 'percent',
          formula: 'Pasivo total ÷ activo total',
        },
        {
          key: 'leverage',
          label: 'Deuda sobre patrimonio',
          value: divide(liabilities, equity),
          format: 'times',
          formula: 'Pasivo total ÷ patrimonio',
        },
      ],
    },
    {
      key: 'profitability',
      label: 'Rentabilidad',
      ratios: [
        {
          key: 'grossMargin',
          label: 'Margen bruto',
          value: divide(summary.grossProfitNio, revenue),
          format: 'percent',
          formula: 'Utilidad bruta ÷ ventas',
        },
        {
          key: 'netMargin',
          label: 'Margen neto',
          value: divide(summary.netProfitNio, revenue),
          format: 'percent',
          formula: 'Utilidad neta ÷ ventas',
        },
        {
          key: 'expenseShare',
          label: 'Gastos sobre ventas',
          value: divide(summary.expensesNio, revenue),
          format: 'percent',
          formula: 'Gastos ÷ ventas',
        },
        {
          key: 'roa',
          label: 'Rendimiento sobre activos',
          value: divide(summary.netProfitNio, current),
          format: 'percent',
          formula: 'Utilidad neta ÷ activo total',
        },
        {
          key: 'roe',
          label: 'Rendimiento sobre patrimonio',
          value: divide(summary.netProfitNio, equity),
          format: 'percent',
          formula: 'Utilidad neta ÷ patrimonio',
        },
      ],
    },
    {
      key: 'activity',
      label: 'Actividad',
      ratios: [
        {
          key: 'inventoryTurnover',
          label: 'Rotación de inventario',
          value: turnover.turnoverPerYear,
          format: 'times',
          formula: 'Costo de ventas anual ÷ inventario',
        },
        {
          key: 'inventoryDays',
          label: 'Días de inventario',
          value: turnover.daysOnHand,
          format: 'days',
          formula: 'Inventario ÷ costo de ventas diario',
        },
        {
          key: 'collectionDays',
          label: 'Días de cobro',
          value: divide(receivables, perDay(revenue)),
          format: 'days',
          formula: 'Cuentas por cobrar ÷ ventas diarias',
        },
        {
          key: 'paymentDays',
          label: 'Días de pago a proveedores',
          value: divide(
            started ? position.payablesNio : null,
            perDay(summary.purchasesNio > 0 ? summary.purchasesNio : null),
          ),
          format: 'days',
          formula: 'Cuentas por pagar ÷ compras diarias',
        },
      ],
    },
  ]
}
