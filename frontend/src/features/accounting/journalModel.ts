import type { AccountingModel, IncomeRow, BalanceRow } from './accountingModel'

export interface LedgerAccount {
  code: string
  name: string
  parent: string | null
  bucket:
    'asset' | 'liability' | 'equity' | 'revenue' | 'cost' | 'expense' | 'tax'
  nature: 'debit' | 'credit'
  postable: boolean
  opening: number
  debit: number
  credit: number
  closing: number
}
export interface JournalRecord {
  id: string
  number: number
  occurred_on: string
  kind: string
  description: string
  reference: string
  currency: 'NIO' | 'USD'
  exchange_rate: number
  voided_at: string | null
  void_reason: string | null
}
export interface LedgerReport {
  startOn: string | null
  from: string
  to: string
  missingCosts: number
  missingSales: number
  accounts: LedgerAccount[]
  entries: JournalRecord[]
}
const round = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
// Contrapartidas de costos desconocidos en private.operational_postings:
// ventas, pérdidas de inventario y sobrantes del conteo físico.
const inventoryCostAccounts = new Set(['1130', '5120', '5150', '4190'])
export function journalModel(
  data: LedgerReport,
  businessName: string,
): AccountingModel {
  const warnings: string[] = []
  if (!data.startOn)
    warnings.push('Falta registrar el comprobante de saldos iniciales.')
  else if (data.to < data.startOn)
    warnings.push(
      `El período termina antes de la apertura del ${data.startOn}.`,
    )
  else if (data.from < data.startOn)
    warnings.push(`El libro contable comienza el ${data.startOn}.`)
  if (data.missingCosts)
    warnings.push(`${data.missingCosts} movimientos sin costo histórico.`)
  if (data.missingSales)
    warnings.push(
      `${data.missingSales} facturas sin detalle contable completo.`,
    )
  // Consultar desde antes de la apertura sólo limita el alcance del libro.
  // Ese aviso no invalida los saldos y movimientos registrados desde su inicio.
  const available =
    data.startOn !== null && data.startOn <= data.to && data.missingSales === 0
  const complete = available && data.missingCosts === 0
  if (available && data.missingCosts)
    warnings.push(
      'Se muestran los importes conocidos. Inventario, costo de venta, otros ingresos y pérdidas de inventario quedan pendientes, junto con los totales y utilidades que dependen de esos costos.',
    )
  const accounts = data.accounts.filter((a) => a.postable)
  const sum = (bucket: LedgerAccount['bucket'], period: boolean) =>
    round(
      accounts
        .filter((a) => a.bucket === bucket)
        .reduce((s, a) => s + (period ? a.debit - a.credit : a.closing), 0),
    )
  const result = (period: boolean) =>
    round(
      -(['revenue', 'cost', 'expense', 'tax'] as const).reduce(
        (s, b) => s + sum(b, period),
        0,
      ),
    )
  const known = (value: number, needsCost = false) =>
    (needsCost ? complete : available) ? round(value) : null
  // El servidor suma los importes disponibles y omite los NULL. No presentar
  // esas sumas parciales como definitivas en las cuentas que reciben costos.
  // El contador global no distingue cuenta ni fecha del costo faltante: se
  // mantienen pendientes sus cuatro columnas hasta contar con ese detalle.
  const accountAmount = (a: LedgerAccount, value: number) =>
    known(value, inventoryCostAccounts.has(a.code))
  const income: IncomeRow[] = []
  for (const [bucket, title] of [
    ['revenue', 'Ingresos'],
    ['cost', 'Costo de venta'],
    ['expense', 'Gastos'],
    ['tax', 'Impuesto sobre la renta'],
  ] as const) {
    income.push({
      code: '',
      description: title,
      kind: 'heading',
      periodNio: null,
      accumulatedNio: null,
    })
    for (const a of accounts.filter((a) => a.bucket === bucket))
      income.push({
        code: a.code,
        description: a.name,
        kind: 'line',
        negative: bucket !== 'revenue',
        periodNio: accountAmount(
          a,
          (a.debit - a.credit) * (bucket === 'revenue' ? -1 : 1),
        ),
        accumulatedNio: accountAmount(
          a,
          a.closing * (bucket === 'revenue' ? -1 : 1),
        ),
      })
    if (bucket === 'cost')
      income.push({
        code: '',
        description: 'Utilidad bruta',
        kind: 'subtotal',
        periodNio: known(-sum('revenue', true) - sum('cost', true), true),
        accumulatedNio: known(
          -sum('revenue', false) - sum('cost', false),
          true,
        ),
      })
  }
  income.push({
    code: '',
    description: 'Utilidad (pérdida) neta',
    kind: 'total',
    periodNio: known(result(true), true),
    accumulatedNio: known(result(false), true),
  })
  const balanceRows = (
    bucket: 'asset' | 'liability' | 'equity',
  ): BalanceRow[] =>
    accounts
      .filter((a) => a.bucket === bucket)
      .map((a) => ({
        code: a.code,
        description: a.name,
        kind: 'line',
        amount: accountAmount(a, a.closing * (bucket === 'asset' ? 1 : -1)),
      }))
  const assets = sum('asset', false),
    liabilities = -sum('liability', false),
    capital = -sum('equity', false) + result(false)
  if (complete && Math.abs(round(assets - liabilities - capital)) >= 0.01)
    warnings.push(
      'El activo no coincide con pasivo más capital. Revisa los asientos.',
    )
  return {
    businessName,
    range: { from: data.from, to: data.to },
    accumulatedFrom: data.startOn ?? data.from,
    catalog: data.accounts.map((a) => ({
      code: a.code,
      description: a.name,
      kind: a.postable ? 'account' : 'group',
      nature: a.nature,
      parent: a.parent ?? undefined,
    })),
    trial: accounts.map((a) => ({
      code: a.code,
      description: a.name,
      openingNio: accountAmount(
        a,
        a.opening * (a.nature === 'credit' ? -1 : 1),
      ),
      debitNio: accountAmount(a, a.debit),
      creditNio: accountAmount(a, a.credit),
      closingNio: accountAmount(
        a,
        a.closing * (a.nature === 'credit' ? -1 : 1),
      ),
    })),
    trialTotals: {
      openingNio: known(
        accounts.reduce((s, a) => s + a.opening, 0),
        true,
      ),
      debitNio: known(
        accounts.reduce((s, a) => s + a.debit, 0),
        true,
      ),
      creditNio: known(
        accounts.reduce((s, a) => s + a.credit, 0),
        true,
      ),
      closingNio: known(
        accounts.reduce((s, a) => s + a.closing, 0),
        true,
      ),
    },
    income,
    balance: {
      left: [
        { code: '1000', description: 'Activo', kind: 'heading', amount: null },
        ...balanceRows('asset'),
        {
          code: '',
          description: 'Total activo',
          kind: 'total',
          amount: known(assets, true),
        },
      ],
      right: [
        { code: '2000', description: 'Pasivo', kind: 'heading', amount: null },
        ...balanceRows('liability'),
        {
          code: '',
          description: 'Total pasivo',
          kind: 'subtotal',
          amount: known(liabilities),
        },
        { code: '3000', description: 'Capital', kind: 'heading', amount: null },
        ...balanceRows('equity'),
        {
          code: '',
          description: 'Resultado acumulado',
          kind: 'line',
          amount: known(result(false), true),
        },
        {
          code: '',
          description: 'Total capital',
          kind: 'subtotal',
          amount: known(capital, true),
        },
        {
          code: '',
          description: 'Total pasivo y capital',
          kind: 'total',
          amount: known(liabilities + capital, true),
        },
      ],
    },
    warnings,
    warningsByView: {
      trial: [...warnings],
      income: [...warnings],
      balance: [...warnings],
    },
  }
}

export function cardSettlement(
  gross: number,
  commissionRate: number,
  withholdingRate: number,
  withholdingBase: 'gross' | 'net_commission' = 'gross',
) {
  if (
    ![gross, commissionRate, withholdingRate].every(Number.isFinite) ||
    gross <= 0 ||
    commissionRate < 0 ||
    withholdingRate < 0 ||
    commissionRate > 100 ||
    withholdingRate > 100
  )
    throw new Error('Importe o tasas inválidos.')
  const commission = round((gross * commissionRate) / 100),
    withholding = round(
      ((withholdingBase === 'gross' ? gross : gross - commission) *
        withholdingRate) /
        100,
    )
  if (commission + withholding > round(gross))
    throw new Error('Las deducciones superan el importe liquidado.')
  return {
    commission,
    withholding,
    net: round(gross - commission - withholding),
  }
}
