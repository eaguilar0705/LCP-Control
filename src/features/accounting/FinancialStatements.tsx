import { useCallback, useMemo, useState } from 'react'
import { Card, ErrorState, LoadingState, Select } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { formatCurrency, formatDate } from '../../lib/format'
import { accountingSummary } from '../reports/accounting'
import {
  presetLabels,
  presetRange,
  type Preset,
  type ReportRange,
} from '../reports/model'
import {
  incomeStatement,
  shareOfRevenue,
  type StatementRow,
} from '../reports/statement'
import type { ReportData } from '../reports/digest'
import { balanceSheet } from './balanceSheet'
import type { FinancePosition } from './finance'

const statements = {
  income: 'Estado de resultados',
  balance: 'Balance general',
} as const
type Statement = keyof typeof statements
const percent = new Intl.NumberFormat('es-NI', {
  style: 'percent',
  maximumFractionDigits: 1,
})

export function FinancialStatements() {
  const { reportService, financeService } = useServices()
  const [statement, setStatement] = useState<Statement>('income')
  const [preset, setPreset] = useState<Preset>('30d')
  const [range, setRange] = useState<ReportRange>(() => presetRange('30d'))
  const load = useCallback(async () => {
    const [report, finance] = await Promise.all([
      reportService.getSource(range),
      financeService.getLedger(range),
    ])
    return { report, position: finance.position }
  }, [reportService, financeService, range])
  const { data, loading, error, retry } = useQuery(load)
  return (
    <Card className="accounting-card">
      <div className="filter-grid">
        <Select
          label="Estado financiero"
          value={statement}
          onChange={(event) => setStatement(event.target.value as Statement)}
        >
          {Object.entries(statements).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          label="Período"
          value={preset}
          onChange={(event) => {
            const next = event.target.value as Preset
            setPreset(next)
            setRange(presetRange(next))
          }}
        >
          {(Object.keys(presetLabels) as Preset[]).map((key) => (
            <option key={key} value={key}>
              {presetLabels[key]}
            </option>
          ))}
        </Select>
      </div>
      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <StatementTable
          report={data.report}
          position={data.position}
          statement={statement}
        />
      )}
    </Card>
  )
}

function StatementTable({
  report,
  position,
  statement,
}: {
  report: ReportData
  position: FinancePosition
  statement: Statement
}) {
  const summary = useMemo(
    () => accountingSummary(report, report.range),
    [report],
  )
  const available = report.accounting?.available ?? false
  const income = statement === 'income'
  const rows = income
    ? incomeStatement(summary)
    : balanceSheet(summary, position)
  const title = statements[statement]
  const amount = (row: StatementRow) => {
    if (!available) return 'Sin activar'
    if (row.amount === null)
      return row.kind === 'info' && !income ? 'Sin registro' : 'Pendiente'
    const text = formatCurrency(row.amount, 'NIO')
    return row.negative ? `(${text})` : text
  }
  const period = income
    ? `Del ${formatDate(report.range.from)} al ${formatDate(report.range.to)}`
    : `Al ${formatDate(report.range.to)}${position.started ? '' : ' · Falta el saldo inicial de caja y banco'}`
  return (
    <>
      <div className="statement-heading">
        <h2>{title}</h2>
        <p>{period} · C$</p>
      </div>
      <div
        className="accounting-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={title}
      >
        <table className="statement-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Concepto</th>
              <th scope="col" className="num">
                Importe
              </th>
              {income && (
                <th scope="col" className="num">
                  % de ventas
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              if (row.kind === 'heading')
                return (
                  <tr key={row.key} className="statement-group">
                    <th scope="rowgroup" colSpan={income ? 3 : 2}>
                      {row.label}
                    </th>
                  </tr>
                )
              const share = shareOfRevenue(row.amount, summary.revenueNio)
              return (
                <tr key={row.key} className={`statement-${row.kind}`}>
                  <th scope="row">{row.label}</th>
                  <td className="num">{amount(row)}</td>
                  {income && (
                    <td className="num">
                      {row.kind === 'info' || share === null || !available
                        ? ''
                        : percent.format(share)}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
