import { useCallback, useState } from 'react'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import { useQuery } from '../../lib/useQuery'
import { adjustRange, localDay, type ReportRange } from '../reports/model'
import {
  accountMovementPageSize,
  readAccountMovements,
  readLedgerAccountOptions,
} from './journalService'

const title = 'Movimientos por cuenta'

export function AccountMovements() {
  const today = localDay(new Date())
  const [account, setAccount] = useState('')
  const [range, setRange] = useState({ from: '', to: today })
  const accounts = useQuery(readLedgerAccountOptions)

  function setDay(edge: keyof ReportRange, value: string) {
    const day = value > today ? today : value
    setRange((current) => {
      if (!day && edge === 'from') return { ...current, from: '' }
      if (!day) return current
      return adjustRange(current, edge, day)
    })
  }

  return (
    <Card className="accounting-card report-filters">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      {accounts.error ? (
        <ErrorState message={accounts.error} retry={accounts.retry} />
      ) : !accounts.data ? (
        <LoadingState />
      ) : (
        <>
          <div className="filter-grid account-movements-filters">
            <Select
              label="Cuenta contable"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            >
              <option value="">Seleccionar cuenta</option>
              {accounts.data.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.displayCode ?? option.display_code ?? option.code} ·{' '}
                  {option.name}
                  {option.active ? '' : ' (inactiva)'}
                </option>
              ))}
            </Select>
            <Input
              label="Desde"
              type="date"
              value={range.from}
              max={range.to}
              onChange={(event) => setDay('from', event.target.value)}
            />
            <Input
              label="Hasta"
              type="date"
              value={range.to}
              min={range.from || undefined}
              max={today}
              onChange={(event) => setDay('to', event.target.value)}
            />
            <Button
              variant="secondary"
              disabled={!range.from && range.to === today}
              onClick={() => setRange({ from: '', to: today })}
            >
              Todo el historial
            </Button>
          </div>
          {account ? (
            <AccountMovementHistory
              key={`${account}:${range.from}:${range.to}`}
              account={account}
              range={range}
            />
          ) : (
            <p className="accounting-note">
              Selecciona una cuenta para consultar sus movimientos.
            </p>
          )}
        </>
      )}
    </Card>
  )
}

function amount(value: number | null) {
  return value === null ? 'Pendiente' : formatCurrency(value, 'NIO')
}

function AccountMovementHistory({
  account,
  range: { from, to },
}: {
  account: string
  range: ReportRange
}) {
  const [paging, setPaging] = useState<{
    offset: number
    revision: string
  } | null>(null)
  const offset = paging?.offset ?? 0
  const load = useCallback(
    () => readAccountMovements(account, from || null, to, offset),
    [account, from, to, offset],
  )
  const { data, error, retry } = useQuery(load)

  if (error) return <ErrorState message={error} retry={retry} />
  if (!data || data.offset !== offset) return <LoadingState />
  if (paging && paging.revision !== data.revision)
    return (
      <ErrorState
        message="Los movimientos cambiaron durante la consulta. Vuelve a la primera página para ver los saldos actualizados."
        retry={() => {
          setPaging(null)
          retry()
        }}
      />
    )

  const summaries = [
    ['Saldo inicial', data.opening],
    ['Debe del período', data.debit],
    ['Haber del período', data.credit],
    ['Saldo final', data.closing],
  ] as const
  const goToPage = (nextOffset: number) =>
    setPaging({ offset: nextOffset, revision: data.revision })
  const atLastPage = offset + data.rows.length >= data.total

  return (
    <>
      <dl className="accounting-breakdown account-movements-summary">
        {summaries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{amount(value)}</dd>
          </div>
        ))}
      </dl>
      {data.rows.length === 0 ? (
        <p className="accounting-note">Sin movimientos en este período.</p>
      ) : (
        <div
          className="accounting-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={title}
        >
          <table className="accounting-table account-movements-table">
            <caption className="sr-only">
              Movimientos en córdobas, del más antiguo al más reciente
            </caption>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Origen</th>
                <th scope="col">Referencia</th>
                <th scope="col">Concepto</th>
                <th scope="col" className="num">
                  Debe
                </th>
                <th scope="col" className="num">
                  Haber
                </th>
                <th scope="col" className="num">
                  Saldo
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <time dateTime={row.day}>{formatDate(row.day)}</time>
                  </td>
                  <td>{row.source}</td>
                  <td>{row.reference || '—'}</td>
                  <td>{row.description || '—'}</td>
                  <td className="num">{amount(row.debit)}</td>
                  <td className="num">{amount(row.credit)}</td>
                  <td className="num">{amount(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(offset > 0 || data.total > accountMovementPageSize) && (
        <nav className="form-actions" aria-label="Páginas de movimientos">
          <Button
            variant="secondary"
            disabled={offset === 0}
            onClick={() => goToPage(offset - accountMovementPageSize)}
          >
            Anterior
          </Button>
          <span role="status">
            {data.rows.length
              ? `${offset + 1}–${offset + data.rows.length}`
              : 0}{' '}
            de {data.total} movimientos
          </span>
          <Button
            variant="secondary"
            disabled={atLastPage}
            onClick={() => goToPage(offset + accountMovementPageSize)}
          >
            Siguiente
          </Button>
          <Button
            variant="secondary"
            disabled={atLastPage}
            onClick={() =>
              goToPage(
                Math.floor((data.total - 1) / accountMovementPageSize) *
                  accountMovementPageSize,
              )
            }
          >
            Última
          </Button>
        </nav>
      )}
    </>
  )
}
