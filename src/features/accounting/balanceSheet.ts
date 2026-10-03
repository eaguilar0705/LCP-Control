import { roundMoney, type accountingSummary } from '../reports/accounting'
import type { StatementRow } from '../reports/statement'

type AccountingSummary = ReturnType<typeof accountingSummary>

/**
 * Balance general con lo que el sistema registra: el inventario al costo
 * promedio. Efectivo, cuentas por cobrar y deudas no se llevan en el sistema,
 * así que salen sin importe y el patrimonio se obtiene por diferencia.
 */
export function balanceSheet(summary: AccountingSummary): StatementRow[] {
  const assets = summary.inventoryCostNio
  const liabilities = 0
  const equity = roundMoney(assets - liabilities)
  const net = summary.netProfitNio
  const earlier = net === null ? null : roundMoney(equity - net)
  return [
    { key: 'assets', label: 'Activos', amount: null, kind: 'heading' },
    {
      key: 'inventory',
      label: 'Inventario de mercadería (costo promedio)',
      amount: assets,
      kind: 'line',
    },
    { key: 'cash', label: 'Efectivo y bancos', amount: null, kind: 'info' },
    {
      key: 'receivables',
      label: 'Cuentas por cobrar',
      amount: null,
      kind: 'info',
    },
    {
      key: 'assetsTotal',
      label: 'Total activos',
      amount: assets,
      kind: 'subtotal',
    },
    { key: 'liabilities', label: 'Pasivos', amount: null, kind: 'heading' },
    { key: 'loans', label: 'Préstamos por pagar', amount: null, kind: 'info' },
    {
      key: 'payables',
      label: 'Cuentas por pagar a proveedores',
      amount: null,
      kind: 'info',
    },
    {
      key: 'liabilitiesTotal',
      label: 'Total pasivos',
      amount: liabilities,
      kind: 'subtotal',
    },
    { key: 'equity', label: 'Patrimonio', amount: null, kind: 'heading' },
    {
      key: 'earlier',
      label: 'Capital y resultados anteriores',
      amount: earlier,
      kind: 'line',
    },
    {
      key: 'net',
      label: 'Utilidad neta del período',
      amount: net,
      kind: 'line',
    },
    {
      key: 'equityTotal',
      label: 'Total patrimonio',
      amount: equity,
      kind: 'subtotal',
    },
    {
      key: 'total',
      label: 'Total pasivo y patrimonio',
      amount: roundMoney(liabilities + equity),
      kind: 'total',
    },
  ]
}
