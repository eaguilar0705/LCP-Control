import { buildWorkbook, type CellValue, type Sheet } from '../../lib/xlsx'
import { download } from '../reports/export'
import { accountingViews, type AccountingModel } from './accountingModel'

const numeric = (value: number | null): CellValue =>
  value === null ? 'Pendiente' : value
const signed = (value: number | null, negative = false): CellValue =>
  value === null ? 'Pendiente' : negative ? -value : value

/** Las mismas cuatro vistas de pantalla, sin anexos ni cifras de ejemplo. */
export function accountingWorkbookSheets(model: AccountingModel): Sheet[] {
  const notes = [
    model.businessName,
    `Del ${model.range.from} al ${model.range.to}. Importes en NIO.`,
    'Pendiente indica información insuficiente; no equivale a cero. Revisa los avisos de este estado.',
  ]
  return [
    {
      name: accountingViews.catalog,
      notes: [model.businessName, accountingViews.catalog],
      columns: [
        { header: 'Código', width: 15 },
        { header: 'Descripción', width: 68 },
      ],
      rows: model.catalog.map((row) => [row.code, row.description]),
    },
    {
      name: accountingViews.trial,
      notes: [
        ...notes,
        ...model.warningsByView.trial,
        'El saldo inicial corresponde al día anterior al inicio del período. Debe y Haber incluyen los movimientos del período.',
        'Saldo final: deudoras = inicial + Debe − Haber; acreedoras = inicial − Debe + Haber.',
        'Los totales de saldos muestran la diferencia entre deudores y acreedores.',
      ],
      columns: [
        { header: 'Cuenta', width: 12 },
        { header: 'Descripción', width: 65 },
        ...['Saldo inicial', 'Debe', 'Haber', 'Saldo final'].map((header) => ({
          header,
          width: 22,
          format: 'money' as const,
        })),
      ],
      rows: [
        ...model.trial.map((row) => [
          row.code,
          row.description,
          numeric(row.openingNio),
          numeric(row.debitNio),
          numeric(row.creditNio),
          numeric(row.closingNio),
        ]),
        [
          '',
          'Totales',
          numeric(model.trialTotals.openingNio),
          numeric(model.trialTotals.debitNio),
          numeric(model.trialTotals.creditNio),
          numeric(model.trialTotals.closingNio),
        ],
      ],
    },
    {
      name: accountingViews.income,
      notes: [
        ...notes,
        `Acumulado desde ${model.accumulatedFrom}.`,
        ...model.warningsByView.income,
      ],
      columns: [
        { header: 'Cuenta', width: 12 },
        { header: 'Descripción', width: 50 },
        { header: 'Movimiento del período', width: 27, format: 'money' },
        { header: 'Acumulado a fecha', width: 27, format: 'money' },
      ],
      rows: model.income.map((row) => [
        row.code,
        row.description,
        row.kind === 'heading' ? null : signed(row.periodNio, row.negative),
        row.kind === 'heading'
          ? null
          : signed(row.accumulatedNio, row.negative),
      ]),
    },
    {
      name: accountingViews.balance,
      notes: [
        model.businessName,
        `Al ${model.range.to}. Importes en NIO.`,
        `Resultado acumulado desde ${model.accumulatedFrom}.`,
        'Pendiente indica información insuficiente; no equivale a cero. Revisa los avisos de este estado.',
        ...model.warningsByView.balance,
      ],
      columns: [
        { header: 'Código', width: 12 },
        { header: 'Activo', width: 55 },
        { header: 'Saldo NIO', width: 23, format: 'money' },
        { header: '', width: 4 },
        { header: 'Código', width: 12 },
        { header: 'Pasivo y capital', width: 65 },
        { header: 'Saldo NIO', width: 23, format: 'money' },
      ],
      rows: Array.from(
        {
          length: Math.max(
            model.balance.left.length,
            model.balance.right.length,
          ),
        },
        (_, index) => {
          const left = model.balance.left[index]
          const right = model.balance.right[index]
          return [
            left?.code ?? '',
            left?.description ?? '',
            !left || left.kind === 'heading' ? null : numeric(left.amount),
            null,
            right?.code ?? '',
            right?.description ?? '',
            !right || right.kind === 'heading' ? null : numeric(right.amount),
          ]
        },
      ),
    },
  ]
}

export function accountingWorkbook(model: AccountingModel) {
  download(
    buildWorkbook(accountingWorkbookSheets(model)),
    `contabilidad-${model.range.from}-a-${model.range.to}.xlsx`,
  )
}
