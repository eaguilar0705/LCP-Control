import { buildWorkbook, type Sheet } from '../../lib/xlsx'
import { accountingSummary } from '../reports/accounting'
import { accountingSheets } from '../reports/accountingExport'
import { download } from '../reports/export'
import type { ReportData } from '../reports/digest'
import type { ReportRange } from '../reports/model'
import { incomeStatement, type StatementRow } from '../reports/statement'
import { balanceSheet } from './balanceSheet'
import {
  financeAccounts,
  financeKinds,
  toNio,
  type CreditLedger,
  type FinanceLedger,
  type FinancePosition,
} from './finance'
import { financialRatios } from './ratios'
import {
  cashflowCategories,
  type CashflowReport,
  type CashClosingRecord,
} from './cashflow'

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
  extra: {
    ledger?: FinanceLedger
    credits?: CreditLedger
    cashflow?: CashflowReport
    closings?: CashClosingRecord[]
  } = {},
) {
  const summary = accountingSummary(report, range)
  const notes = [
    businessName,
    `Del ${range.from} al ${range.to}. Importes en NIO.`,
  ]
  const ratios = financialRatios(summary, position, range)
  const sheets: Sheet[] = [
    statementSheet(
      'Estado de resultados',
      [
        ...notes,
        ...(!summary.complete
          ? [
              'Información incompleta: los importes conocidos son parciales y la utilidad queda pendiente.',
            ]
          : []),
      ],
      incomeStatement(summary),
    ),
    statementSheet(
      'Balance general',
      [
        businessName,
        `Al ${range.to}. Importes en NIO.`,
        'Balance provisional: patrimonio inicial y resultados acumulados por conciliar. El inventario sólo se valora cuando el corte es hoy.',
      ],
      balanceSheet(summary, position, range.to),
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
  if (extra.ledger)
    sheets.push({
      name: 'Movimientos de dinero',
      notes,
      columns: [
        { header: 'Fecha' },
        { header: 'Movimiento', width: 25 },
        { header: 'Cuenta', width: 25 },
        { header: 'Destino' },
        { header: 'Persona o negocio', width: 30 },
        { header: 'Descripción', width: 42 },
        { header: 'Referencia', width: 25 },
        { header: 'Importe original', format: 'money' },
        { header: 'Moneda' },
        { header: 'Tipo de cambio', format: 'number' },
        { header: 'Importe NIO', format: 'money' },
        { header: 'Factura vinculada', width: 40 },
        { header: 'Pedido vinculado', width: 40 },
        { header: 'Estado' },
        { header: 'Motivo de anulación', width: 35 },
      ],
      rows: extra.ledger.entries.map((row) => [
        row.occurredOn,
        financeKinds[row.kind],
        financeAccounts[row.account],
        row.toAccount ? financeAccounts[row.toAccount] : '',
        row.counterparty,
        row.description,
        row.reference,
        row.amount,
        row.currency,
        row.exchangeRate,
        toNio(row),
        row.documentId ?? '',
        row.shipmentId ?? '',
        row.voidedAt ? 'Anulado' : 'Vigente',
        row.voidReason,
      ]),
    })
  if (extra.credits)
    sheets.push({
      name: 'Cobros y pagos',
      notes: [
        ...notes,
        `Saldos al ${extra.credits.at}.`,
        ...(!extra.credits.available ? ['Módulo pendiente de activar.'] : []),
        ...(extra.credits.legacyPayments
          ? ['Existen abonos anteriores sin vínculo; revisa su asignación.']
          : []),
      ],
      columns: [
        { header: 'Cuenta', width: 24 },
        { header: 'Cliente o proveedor', width: 35 },
        { header: 'Referencia', width: 25 },
        { header: 'Fecha' },
        { header: 'Importe original NIO', format: 'money' },
        { header: 'Abonado NIO', format: 'money' },
        { header: 'Saldo NIO', format: 'money' },
      ],
      rows: extra.credits.rows.map((row) => [
        row.kind === 'receivable' ? 'Por cobrar' : 'Por pagar',
        row.counterparty,
        row.reference,
        row.occurredOn,
        row.originalNio,
        row.paidNio,
        row.balanceNio,
      ]),
    })
  if (extra.cashflow)
    sheets.push({
      name: 'Flujo de efectivo',
      notes: [
        ...notes,
        'Cobros y pagos externos. Aperturas y transferencias internas se muestran por separado.',
        ...(!extra.cashflow.available ? ['Módulo pendiente de activar.'] : []),
        ...(extra.cashflow.missingSales
          ? ['Faltan importes de ventas: información parcial.']
          : []),
      ],
      columns: [
        { header: 'Fecha' },
        { header: 'Cuenta' },
        { header: 'Concepto', width: 35 },
        { header: 'Operaciones', format: 'integer' },
        { header: 'Entradas NIO', format: 'money' },
        { header: 'Salidas NIO', format: 'money' },
      ],
      rows: extra.cashflow.rows.map((row) => [
        row.day,
        financeAccounts[row.account],
        cashflowCategories[row.category],
        row.operations,
        row.inflowNio,
        row.outflowNio,
      ]),
    })
  if (extra.closings)
    sheets.push({
      name: 'Arqueos de caja',
      notes: [
        ...notes,
        'El saldo esperado guardado conserva la foto del momento del arqueo.',
      ],
      columns: [
        { header: 'Día' },
        { header: 'Contado NIO', format: 'money' },
        { header: 'Contado USD', format: 'money' },
        { header: 'Tasa USD', format: 'number' },
        { header: 'Total contado NIO', format: 'money' },
        { header: 'Esperado guardado NIO', format: 'money' },
        { header: 'Diferencia NIO', format: 'money' },
        { header: 'Esperado actual NIO', format: 'money' },
        { header: 'Cambios posteriores' },
        { header: 'Observación', width: 45 },
        { header: 'Estado' },
        { header: 'Motivo de anulación', width: 35 },
      ],
      rows: extra.closings.map((row) => [
        row.closedOn,
        row.countedNio,
        row.countedUsd,
        row.exchangeRate,
        row.countedTotalNio,
        row.expectedNio,
        row.differenceNio,
        row.currentExpectedNio,
        row.changed ? 'Revisar' : '',
        row.note,
        row.voidedAt ? 'Anulado' : 'Vigente',
        row.voidReason,
      ]),
    })
  download(
    buildWorkbook(sheets),
    `contabilidad-${range.from}-a-${range.to}.xlsx`,
  )
}
