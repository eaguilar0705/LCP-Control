import { roundMoney, type accountingSummary } from '../reports/accounting'
import type { StatementRow } from '../reports/statement'
import type { FinancePosition } from './finance'

type AccountingSummary = ReturnType<typeof accountingSummary>

/**
 * Balance general al fin del período. El inventario sale del costo promedio;
 * caja, bancos, cuentas por cobrar y deudas salen de las ventas, pedidos,
 * gastos y movimientos registrados desde el primer saldo inicial. Mientras no
 * haya saldo inicial esas cuentas quedan sin importe.
 *
 * El capital es lo registrado como saldo inicial y aportes, menos retiros. Lo
 * que falta para cuadrar —el inventario que ya había, resultados de períodos
 * anteriores— se muestra aparte, así el balance siempre cuadra y la diferencia
 * queda a la vista.
 */
export function balanceSheet(
  summary: AccountingSummary,
  position: FinancePosition,
): StatementRow[] {
  const started = position.started
  const known = (amount: number) => (started ? amount : null)
  const cash = roundMoney(position.cash.caja + position.cash.banco)
  const assets = roundMoney(
    summary.inventoryCostNio + (started ? cash + position.receivablesNio : 0),
  )
  const liabilities = started
    ? roundMoney(position.loansNio + position.payablesNio)
    : 0
  const equity = roundMoney(assets - liabilities)
  const capital = started ? position.capitalNio : 0
  const net = summary.netProfitNio
  const earlier = net === null ? null : roundMoney(equity - capital - net)
  return [
    { key: 'assets', label: 'Activos', amount: null, kind: 'heading' },
    { key: 'cash', label: 'Caja', amount: known(position.cash.caja), kind: started ? 'line' : 'info' },
    { key: 'bank', label: 'Banco', amount: known(position.cash.banco), kind: started ? 'line' : 'info' },
    {
      key: 'receivables',
      label: 'Cuentas por cobrar',
      amount: known(position.receivablesNio),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'inventory',
      label: 'Inventario (costo promedio)',
      amount: summary.inventoryCostNio,
      kind: 'line',
    },
    { key: 'assetsTotal', label: 'Total activos', amount: assets, kind: 'subtotal' },
    { key: 'liabilities', label: 'Pasivos', amount: null, kind: 'heading' },
    {
      key: 'loans',
      label: 'Préstamos por pagar',
      amount: known(position.loansNio),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'payables',
      label: 'Cuentas por pagar a proveedores',
      amount: known(position.payablesNio),
      kind: started ? 'line' : 'info',
    },
    { key: 'liabilitiesTotal', label: 'Total pasivos', amount: liabilities, kind: 'subtotal' },
    { key: 'equity', label: 'Patrimonio', amount: null, kind: 'heading' },
    { key: 'capital', label: 'Capital', amount: capital, kind: 'line' },
    {
      key: 'earlier',
      label: 'Resultados anteriores y ajustes',
      amount: earlier,
      kind: 'line',
    },
    { key: 'net', label: 'Utilidad neta del período', amount: net, kind: 'line' },
    { key: 'equityTotal', label: 'Total patrimonio', amount: equity, kind: 'subtotal' },
    {
      key: 'total',
      label: 'Total pasivo y patrimonio',
      amount: roundMoney(liabilities + equity),
      kind: 'total',
    },
  ]
}
