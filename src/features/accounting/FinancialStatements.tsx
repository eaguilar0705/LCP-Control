import { useMemo, useState } from 'react'
import { Card, Select } from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import { accountingSummary } from '../reports/accounting'
import {
  incomeStatement,
  shareOfRevenue,
  type StatementRow,
} from '../reports/statement'
import type { ReportData } from '../reports/digest'
import { balanceSheet } from './balanceSheet'
import { localDay } from '../reports/model'
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

export function FinancialStatements({
  report,
  position,
}: {
  report: ReportData
  position: FinancePosition
}) {
  const [statement, setStatement] = useState<Statement>('income')
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
      </div>
      <StatementTable
        report={report}
        position={position}
        statement={statement}
      />
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
    : balanceSheet(summary, position, report.range.to)
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
      {income && !summary.complete && (
        <p className="accounting-callout" role="status">
          Estado de resultados incompleto: los importes disponibles son
          parciales. Hay {summary.missingCostUnits} unidades vendidas sin costo,{' '}
          {summary.missingRevenueLines} renglones sin ingreso confirmado y{' '}
          {summary.missingWriteOffUnits} unidades de salida sin valorar. La
          utilidad queda pendiente hasta completar la información del período.
        </p>
      )}
      {!income && (
        <div className="accounting-callout" role="status">
          <strong>Balance provisional</strong>
          <p>
            El patrimonio inicial y los resultados acumulados requieren
            conciliación.
            {report.range.to !== localDay(new Date())
              ? ' El inventario disponible corresponde a hoy; su valor histórico queda pendiente.'
              : summary.unvaluedProducts > 0
                ? ` Hay ${summary.unvaluedProducts} perfumes con existencias sin valorar.`
                : ''}
            {position.missingSales > 0
              ? ` Hay ${position.missingSales} facturas sin importe contable confirmado.`
              : ''}
          </p>
        </div>
      )}
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
