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
export function journalModel(
  data: LedgerReport,
  businessName: string,
): AccountingModel {
  const warnings: string[] = []
  if (!data.startOn)
    warnings.push('Falta registrar el comprobante de saldos iniciales.')
  else if (data.from < data.startOn)
    warnings.push(`El libro contable comienza el ${data.startOn}.`)
  if (data.missingCosts)
    warnings.push(`${data.missingCosts} movimientos sin costo histórico.`)
  if (data.missingSales)
    warnings.push(
      `${data.missingSales} facturas sin detalle contable completo.`,
    )
  const complete = warnings.length === 0
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
  const known = (value: number) => (complete ? round(value) : null)
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
        periodNio: known(
          (a.debit - a.credit) * (bucket === 'revenue' ? -1 : 1),
        ),
        accumulatedNio: known(a.closing * (bucket === 'revenue' ? -1 : 1)),
      })
    if (bucket === 'cost')
      income.push({
        code: '',
        description: 'Utilidad bruta',
        kind: 'subtotal',
        periodNio: known(-sum('revenue', true) - sum('cost', true)),
        accumulatedNio: known(-sum('revenue', false) - sum('cost', false)),
      })
  }
  income.push({
    code: '',
    description: 'Utilidad (pérdida) neta',
    kind: 'total',
    periodNio: known(result(true)),
    accumulatedNio: known(result(false)),
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
        amount: known(a.closing * (bucket === 'asset' ? 1 : -1)),
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
      openingNio: known(a.opening * (a.nature === 'credit' ? -1 : 1)),
      debitNio: known(a.debit),
      creditNio: known(a.credit),
      closingNio: known(a.closing * (a.nature === 'credit' ? -1 : 1)),
    })),
    trialTotals: {
      openingNio: known(accounts.reduce((s, a) => s + a.opening, 0)),
      debitNio: known(accounts.reduce((s, a) => s + a.debit, 0)),
      creditNio: known(accounts.reduce((s, a) => s + a.credit, 0)),
      closingNio: known(accounts.reduce((s, a) => s + a.closing, 0)),
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
          amount: known(assets),
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
          amount: known(result(false)),
        },
        {
          code: '',
          description: 'Total capital',
          kind: 'subtotal',
          amount: known(capital),
        },
        {
          code: '',
          description: 'Total pasivo y capital',
          kind: 'total',
          amount: known(liabilities + capital),
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
