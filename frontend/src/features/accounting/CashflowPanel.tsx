import { useState } from 'react'
import { Badge, Card, EmptyState, Select } from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import type { CashflowLedger } from './cashflow'

const labels: Record<string, string> = {
  sales: 'Ventas cobradas',
  collection: 'Abonos de clientes',
  purchases: 'Compras pagadas',
  supplier_payment: 'Abonos a proveedores',
  expense: 'Gastos pagados',
  loan_payment: 'Capital de préstamos pagado',
  capital: 'Aportes del dueño',
  withdrawal: 'Retiros del dueño',
  loan: 'Préstamos recibidos',
  transfer: 'Transferencias internas',
  opening: 'Saldos iniciales',
}
const money = (value: number | null) =>
  value === null ? 'Pendiente' : formatCurrency(value, 'NIO')

export function CashflowPanel({ ledger }: { ledger: CashflowLedger }) {
  const [account, setAccount] = useState('all')
  const rows = ledger.rows.filter(
    (row) => account === 'all' || row.account === account,
  )
  // Transferencias internas y saldos de apertura no son cobros ni pagos externos.
  const external = rows.filter(
    (row) => !['transfer', 'opening'].includes(row.category),
  )
  const inflows = external.reduce((sum, row) => sum + row.inflowNio, 0)
  const outflows = external.reduce((sum, row) => sum + row.outflowNio, 0)
  const group = (categories: string[]) =>
    external
      .filter((row) => categories.includes(row.category))
      .reduce((sum, row) => sum + row.inflowNio - row.outflowNio, 0)
  const opening =
    account === 'all'
      ? ledger.opening.caja === null || ledger.opening.banco === null
        ? null
        : ledger.opening.caja + ledger.opening.banco
      : ledger.opening[account as 'caja' | 'banco']
  const closing =
    account === 'all'
      ? ledger.closing.caja === null || ledger.closing.banco === null
        ? null
        : ledger.closing.caja + ledger.closing.banco
      : ledger.closing[account as 'caja' | 'banco']
  if (!ledger.available)
    return (
      <Card className="accounting-card">
        <EmptyState title="Flujo de efectivo pendiente de activar" />
        <p className="accounting-note">
          Aplica la actualización de contabilidad en la base de datos para
          consultar los cobros y pagos.
        </p>
      </Card>
    )
  return (
    <>
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Flujo de efectivo</h2>
          <Badge>
            {formatDate(ledger.from)} – {formatDate(ledger.to)}
          </Badge>
        </div>
        <Select
          label="Cuenta de dinero"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        >
          <option value="all">Caja y banco</option>
          <option value="caja">Caja</option>
          <option value="banco">Banco</option>
        </Select>
        <p className="accounting-note">
          Sólo incluye dinero recibido o pagado. Las facturas pendientes de
          cobro y los pedidos a crédito aparecen cuando se registra su abono.
          Los importes usan la tasa de cada operación.
        </p>
        {ledger.missingSales > 0 && (
          <p className="accounting-callout" role="status">
            Hay {ledger.missingSales} facturas sin importe contable confirmado.
            Los cobros conocidos se muestran como información parcial; los
            saldos quedan pendientes.
          </p>
        )}
        <dl className="accounting-breakdown">
          <div>
            <dt>Saldo anterior al período</dt>
            <dd>{money(opening)}</dd>
          </div>
          <div>
            <dt>Cobros y otras entradas</dt>
            <dd>{money(inflows)}</dd>
          </div>
          <div>
            <dt>Pagos y otras salidas</dt>
            <dd>{money(outflows)}</dd>
          </div>
          <div>
            <dt>Flujo neto del período</dt>
            <dd>{money(inflows - outflows)}</dd>
          </div>
          <div>
            <dt>Saldo al final del período</dt>
            <dd>{money(closing)}</dd>
          </div>
        </dl>
        <p className="accounting-note">
          Los saldos incluyen aperturas y transferencias de la cuenta. Al sumar
          caja y banco, las transferencias internas se compensan. Una cuenta sin
          saldo inicial queda pendiente.
        </p>
      </Card>
      <div className="accounting-two-columns">
        <Card className="accounting-card">
          <h3>Operación del negocio</h3>
          <strong>
            {money(
              group([
                'sales',
                'collection',
                'purchases',
                'supplier_payment',
                'expense',
              ]),
            )}
          </strong>
          <p className="accounting-note">
            Ventas cobradas y abonos de clientes menos compras pagadas, pagos a
            proveedores y gastos.
          </p>
        </Card>
        <Card className="accounting-card">
          <h3>Dueños y financiamiento</h3>
          <strong>
            {money(group(['capital', 'withdrawal', 'loan', 'loan_payment']))}
          </strong>
          <p className="accounting-note">
            Aportes y préstamos recibidos menos retiros y devolución del capital
            prestado.
          </p>
        </Card>
      </div>
      <Card className="accounting-card">
        <h3>Registro diario de entradas y salidas</h3>
        {!rows.length ? (
          <EmptyState title="Sin movimientos de dinero en el período" />
        ) : (
          <div
            className="accounting-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Entradas y salidas de dinero"
          >
            <table className="accounting-table">
              <caption className="sr-only">
                Entradas y salidas de dinero
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Concepto</th>
                  <th scope="col" className="num">
                    Operaciones
                  </th>
                  <th scope="col" className="num">
                    Entradas C$
                  </th>
                  <th scope="col" className="num">
                    Salidas C$
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.day}:${row.account}:${row.category}`}>
                    <th scope="row">{formatDate(row.day)}</th>
                    <td>{row.account === 'caja' ? 'Caja' : 'Banco'}</td>
                    <td>{labels[row.category] ?? row.category}</td>
                    <td className="num">{row.operations}</td>
                    <td className="num">{money(row.inflowNio)}</td>
                    <td className="num">{money(row.outflowNio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
