import { buildWorkbook, type Sheet } from '../../lib/xlsx'
import { accountingSummary } from '../reports/accounting'
import { accountingSheets } from '../reports/accountingExport'
import { download } from '../reports/export'
import type { ReportData } from '../reports/digest'
import type { ReportRange } from '../reports/model'
import { incomeStatement, type StatementRow } from '../reports/statement'
import { balanceSheet } from './balanceSheet'
import type { FinancePosition } from './finance'
import { financialRatios } from './ratios'

const statementSheet = (
  name: string,
  notes: string[],
  rows: StatementRow[],
): Sheet => ({
  name,
  notes,
  columns: [
    { header: 'Concepto', width: 46 },
    { header: 'Importe NIO', format: 'money', width: 22 },
  ],
  rows: rows.map((row) => [
    row.kind === 'heading' ? row.label.toUpperCase() : row.label,
    row.kind === 'heading'
      ? null
      : row.amount === null
        ? null
        : row.negative
          ? -row.amount
          : row.amount,
  ]),
})

/** El libro de Contabilidad: estados, razones y el detalle contable del período. */
export function accountingWorkbook(
  report: ReportData,
  position: FinancePosition,
  range: ReportRange,
  businessName: string,
) {
  const summary = accountingSummary(report, range)
  const notes = [
    businessName,
    `Del ${range.from} al ${range.to}. Importes en NIO.`,
  ]
  const ratios = financialRatios(summary, position, range)
  const sheets: Sheet[] = [
    statementSheet('Estado de resultados', notes, incomeStatement(summary)),
    statementSheet(
      'Balance general',
      [businessName, `Al ${range.to}. Importes en NIO.`],
      balanceSheet(summary, position),
    ),
    {
      name: 'Razones financieras',
      notes,
      columns: [
        { header: 'Grupo', width: 18 },
        { header: 'Razón', width: 32 },
        { header: 'Valor', format: 'number', width: 16 },
        { header: 'Unidad', width: 12 },
        { header: 'Fórmula', width: 50 },
      ],
      rows: ratios.flatMap((group) =>
        group.ratios.map((ratio) => [
          group.label,
          ratio.label,
          ratio.value === null
            ? null
            : Math.round(
                (ratio.format === 'percent' ? ratio.value * 100 : ratio.value) *
                  100,
              ) / 100,
          { percent: '%', times: 'veces', days: 'días', money: 'NIO' }[
            ratio.format
          ],
          ratio.formula,
        ]),
      ),
    },
    ...accountingSheets(report, range, businessName),
  ]
  download(
    buildWorkbook(sheets),
    `contabilidad-${range.from}-a-${range.to}.xlsx`,
  )
}
