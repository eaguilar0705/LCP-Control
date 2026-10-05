import { roundMoney, type accountingSummary } from '../reports/accounting'
import type { StatementRow } from '../reports/statement'
import type { FinanceAccount, FinancePosition } from './finance'
import { localDay } from '../reports/model'

type AccountingSummary = ReturnType<typeof accountingSummary>

/**
 * Balance general al fin del período. El inventario sale del costo promedio;
 * caja, bancos, cuentas por cobrar y deudas salen de las ventas, pedidos,
 * gastos y movimientos registrados desde el primer saldo inicial. Mientras no
 * haya saldo inicial esas cuentas quedan sin importe.
 *
 * No se utiliza una diferencia como si fuera una utilidad histórica. Hasta
 * registrar el patrimonio inicial y los resultados acumulados, el patrimonio
 * total queda pendiente. El inventario leído es actual: no se presenta como
 * una valoración histórica cuando el corte pertenece a otro día.
 */
export function balanceSheet(
  summary: AccountingSummary,
  position: FinancePosition,
  at = localDay(new Date()),
): StatementRow[] {
  const started = position.started && position.missingSales === 0
  const opened = (account: FinanceAccount) =>
    started && (position.openedAccounts?.includes(account) ?? true)
  const known = (amount: number, account: FinanceAccount) =>
    opened(account) ? amount : null
  const completeOpening = [
    'caja',
    'banco',
    'cobrar',
    'prestamos',
    'proveedores',
  ].every((account) => opened(account as FinanceAccount))
  const inventory =
    at === localDay(new Date()) && !summary.unvaluedProducts
      ? summary.inventoryCostNio
      : null
  const cash = roundMoney(position.cash.caja + position.cash.banco)
  const assets =
    opened('caja') && opened('banco') && opened('cobrar') && inventory !== null
      ? roundMoney(inventory + cash + position.receivablesNio)
      : null
  const liabilities =
    opened('prestamos') && opened('proveedores')
      ? roundMoney(position.loansNio + position.payablesNio)
      : null
  const capital = completeOpening ? position.capitalNio : null
  const net = summary.netProfitNio
  return [
    { key: 'assets', label: 'Activos', amount: null, kind: 'heading' },
    {
      key: 'cash',
      label: 'Caja',
      amount: known(position.cash.caja, 'caja'),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'bank',
      label: 'Banco',
      amount: known(position.cash.banco, 'banco'),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'receivables',
      label: 'Cuentas por cobrar',
      amount: known(position.receivablesNio, 'cobrar'),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'inventory',
      label:
        at === localDay(new Date())
          ? 'Inventario actual (costo promedio)'
          : 'Inventario al corte (pendiente de reconstruir)',
      amount: inventory,
      kind: 'line',
    },
    {
      key: 'assetsTotal',
      label: 'Total activos',
      amount: assets,
      kind: 'subtotal',
    },
    { key: 'liabilities', label: 'Pasivos', amount: null, kind: 'heading' },
    {
      key: 'loans',
      label: 'Préstamos por pagar',
      amount: known(position.loansNio, 'prestamos'),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'payables',
      label: 'Cuentas por pagar a proveedores',
      amount: known(position.payablesNio, 'proveedores'),
      kind: started ? 'line' : 'info',
    },
    {
      key: 'liabilitiesTotal',
      label: 'Total pasivos',
      amount: liabilities,
      kind: 'subtotal',
    },
    { key: 'equity', label: 'Patrimonio', amount: null, kind: 'heading' },
    { key: 'capital', label: 'Capital', amount: capital, kind: 'line' },
    {
      key: 'earlier',
      label: 'Patrimonio inicial y resultados acumulados por conciliar',
      amount: null,
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
      amount: null,
      kind: 'subtotal',
    },
    {
      key: 'total',
      label: 'Total pasivo y patrimonio',
      amount: null,
      kind: 'total',
    },
  ]
}
