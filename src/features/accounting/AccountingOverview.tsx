import { Badge, Button, Card } from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import { accountingSummary } from '../reports/accounting'
import type { ReportData } from '../reports/digest'
import type { FinanceLedger } from './finance'
import type { PeriodSection } from './sections'

export function AccountingOverview({
  report,
  ledger,
  onNavigate,
}: {
  report: ReportData
  ledger: FinanceLedger
  onNavigate: (section: PeriodSection) => void
}) {
  const summary = accountingSummary(report, report.range)
  const position = ledger.position
  const usable = ledger.available && position.started && !position.missingSales
  const opened = (
    account: 'caja' | 'banco' | 'cobrar' | 'prestamos' | 'proveedores',
  ) => usable && (position.openedAccounts?.includes(account) ?? true)
  const money = (value: number | null) =>
    value === null ? 'Pendiente' : formatCurrency(value, 'NIO')
  const alerts = [
    !report.accounting?.available
      ? 'Falta activar el módulo de costos en la base de datos.'
      : '',
    !ledger.available
      ? 'Falta activar el libro de caja y bancos en la base de datos.'
      : '',
    !position.started
      ? 'Registra los saldos iniciales con una misma fecha de inicio.'
      : '',
    position.started &&
    position.openedAccounts &&
    position.openedAccounts.length < 5
      ? 'Completa las cinco cuentas iniciales. Registra cero explícitamente si una no tiene saldo.'
      : '',
    summary.unvaluedProducts
      ? `${summary.unvaluedProducts} perfumes con existencias necesitan costo inicial.`
      : '',
    summary.missingCostUnits
      ? `${summary.missingCostUnits} unidades vendidas no tienen costo congelado.`
      : '',
    summary.missingRevenueLines || position.missingSales
      ? 'Hay ventas sin importe contable confirmado; los saldos quedan pendientes.'
      : '',
    report.truncated || report.accounting?.truncated
      ? 'El período excede el límite de lectura; consulta un rango menor.'
      : '',
  ].filter(Boolean)
  return (
    <>
      <div className="accounting-metrics">
        {[
          [
            'Ventas del período',
            report.accounting?.available ? summary.revenueNio : null,
            'Incluye las ventas a crédito.',
          ],
          [
            'Utilidad del período',
            summary.netProfitNio,
            'Ventas menos costo vendido, gastos y mermas.',
          ],
          [
            'Caja y bancos al corte',
            opened('caja') && opened('banco')
              ? position.cash.caja + position.cash.banco
              : null,
            'Dinero registrado desde el saldo inicial.',
          ],
          [
            'Clientes por cobrar',
            opened('cobrar') ? position.receivablesNio : null,
            'Las ventas a crédito aumentan este saldo; los abonos lo reducen.',
          ],
          [
            'Proveedores por pagar',
            opened('proveedores') ? position.payablesNio : null,
            'Compras a crédito pendientes de pago.',
          ],
          [
            'Préstamos por pagar',
            opened('prestamos') ? position.loansNio : null,
            'Capital de préstamos; el interés se registra como gasto.',
          ],
        ].map(([label, value, description], index) => (
          <div
            key={String(label)}
            className={`accounting-metric ${index === 1 ? 'accounting-metric-highlight' : ''}`}
          >
            <span>{label}</span>
            <strong>{money(value as number | null)}</strong>
            <small>{description}</small>
          </div>
        ))}
      </div>
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Control contable de La Casa del Perfume</h2>
          <Badge tone={alerts.length ? 'warning' : 'success'}>
            {alerts.length ? 'Datos por completar' : 'Registros disponibles'}
          </Badge>
        </div>
        <p className="accounting-note">
          Del {formatDate(report.range.from)} al {formatDate(report.range.to)}.
          Importes consolidados en córdobas con la tasa guardada en cada
          operación.
        </p>
        {alerts.length > 0 && (
          <div className="accounting-callout" role="status">
            <strong>Para completar tus cifras</strong>
            <ul>
              {alerts.map((alert) => (
                <li key={alert}>{alert}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="accounting-overview-actions">
          <Button variant="secondary" onClick={() => onNavigate('movements')}>
            Registrar saldo o movimiento
          </Button>
          <Button variant="secondary" onClick={() => onNavigate('credits')}>
            Revisar cobros y pagos
          </Button>
          <Button variant="secondary" onClick={() => onNavigate('daily')}>
            Contar efectivo
          </Button>
          <Button variant="secondary" onClick={() => onNavigate('cashflow')}>
            Revisar flujo de efectivo
          </Button>
        </div>
      </Card>
      <Card className="accounting-card">
        <h3>Cómo se conectan los registros</h3>
        <ol className="accounting-workflow">
          <li>
            <strong>Recibir perfumes.</strong> El pedido suma unidades en tienda
            o bodega y actualiza el costo promedio con su parte del envío. Su
            forma de pago determina si sale dinero o nace una deuda.
          </li>
          <li>
            <strong>Vender.</strong> La factura descuenta existencias, conserva
            el precio de la lista del cliente y congela el costo vendido. El
            efectivo entra a caja; transferencias y tarjeta van a banco; el
            crédito queda por cobrar.
          </li>
          <li>
            <strong>Cobrar y pagar.</strong> Cada abono reduce el saldo de su
            factura o pedido. No vuelve a sumar ventas ni a descontar gastos.
          </li>
          <li>
            <strong>Revisar el día.</strong> Registra gastos desde caja o banco
            y compara el efectivo contado con el esperado. Aportes, retiros y
            préstamos se muestran aparte de la utilidad.
          </li>
        </ol>
        <p className="accounting-note">
          La compra permanece en el inventario hasta vender el perfume. Su costo
          se descuenta de la utilidad al venderlo; el flujo de efectivo registra
          cuándo se paga.
        </p>
      </Card>
    </>
  )
}
