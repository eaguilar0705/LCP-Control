import type { ReportData } from '../reports/digest'
import {
  accountingSummary,
  expenseCategories,
  roundMoney,
} from '../reports/accounting'
import { localDay, type ReportRange } from '../reports/model'
import type { FinanceAccount, FinanceLedger } from './finance'

export const accountingViews = {
  catalog: 'Catálogo de cuentas',
  trial: 'Balanza de comprobación',
  income: 'Estado de resultado',
  balance: 'Estado de situación financiera',
} as const

export type AccountingView = keyof typeof accountingViews
export interface ChartAccount {
  code: string
  description: string
  kind: 'group' | 'account'
  nature: 'debit' | 'credit'
  parent?: string
}
export type AccountingRowKind =
  'heading' | 'line' | 'subtotal' | 'total' | 'info'
export interface TrialRow {
  code: string
  description: string
  openingNio: number | null
  debitNio: number | null
  creditNio: number | null
  closingNio: number | null
}
export interface IncomeRow {
  code: string
  description: string
  kind: AccountingRowKind
  periodNio: number | null
  accumulatedNio: number | null
  negative?: boolean
}
export interface BalanceRow {
  code: string
  description: string
  kind: AccountingRowKind
  amount: number | null
}
export interface AccountingModel {
  businessName: string
  range: ReportRange
  accumulatedFrom: string
  catalog: ChartAccount[]
  trial: TrialRow[]
  trialTotals: Omit<TrialRow, 'code' | 'description'>
  income: IncomeRow[]
  balance: { left: BalanceRow[]; right: BalanceRow[] }
  warnings: string[]
  warningsByView: { trial: string[]; income: string[]; balance: string[] }
}

/** Cuentas que tienen una fuente real en las operaciones de la perfumería. */
export const chartOfAccounts: ChartAccount[] = [
  { code: '1000', description: 'Activo', kind: 'group', nature: 'debit' },
  {
    code: '1100',
    description: 'Activo circulante',
    kind: 'group',
    nature: 'debit',
    parent: '1000',
  },
  {
    code: '1110',
    description: 'Caja de la perfumería',
    kind: 'account',
    nature: 'debit',
    parent: '1100',
  },
  {
    code: '1120',
    description: 'Bancos de la perfumería',
    kind: 'account',
    nature: 'debit',
    parent: '1100',
  },
  {
    code: '1130',
    description: 'Inventario de perfumes',
    kind: 'account',
    nature: 'debit',
    parent: '1100',
  },
  {
    code: '1140',
    description: 'Cuentas por cobrar a clientes',
    kind: 'account',
    nature: 'debit',
    parent: '1100',
  },
  { code: '2000', description: 'Pasivo', kind: 'group', nature: 'credit' },
  {
    code: '2100',
    description: 'Pasivo circulante',
    kind: 'group',
    nature: 'credit',
    parent: '2000',
  },
  {
    code: '2111',
    description: 'Proveedores de perfumes',
    kind: 'account',
    nature: 'credit',
    parent: '2100',
  },
  {
    code: '2113',
    description: 'Préstamos por pagar',
    kind: 'account',
    nature: 'credit',
    parent: '2100',
  },
  { code: '3000', description: 'Capital', kind: 'group', nature: 'credit' },
  {
    code: '3110',
    description: 'Capital registrado y aportes del dueño',
    kind: 'account',
    nature: 'credit',
    parent: '3000',
  },
  {
    code: '3190',
    description: 'Patrimonio inicial y resultados anteriores por conciliar',
    kind: 'account',
    nature: 'credit',
    parent: '3000',
  },
  { code: '4000', description: 'Ingresos', kind: 'group', nature: 'credit' },
  {
    code: '4110',
    description: 'Ventas netas de perfumes',
    kind: 'account',
    nature: 'credit',
    parent: '4000',
  },
  { code: '5000', description: 'Egresos', kind: 'group', nature: 'debit' },
  {
    code: '5120',
    description: 'Costo de perfumes vendidos',
    kind: 'account',
    nature: 'debit',
    parent: '5000',
  },
  {
    code: '5130',
    description: 'Gastos de administración y ventas',
    kind: 'account',
    nature: 'debit',
    parent: '5000',
  },
  {
    code: '5140',
    description: 'Gastos financieros',
    kind: 'account',
    nature: 'debit',
    parent: '5000',
  },
  {
    code: '5150',
    description: 'Mermas y otras salidas de perfumes',
    kind: 'account',
    nature: 'debit',
    parent: '5000',
  },
  {
    code: '6000',
    description: 'Impuestos y tasas',
    kind: 'account',
    nature: 'debit',
  },
]

const salesTaxAccount: ChartAccount = {
  code: '2116',
  description: 'Impuesto sobre ventas registrado',
  kind: 'account',
  nature: 'credit',
  parent: '2100',
}
const financialCodes: Record<string, FinanceAccount | 'capital'> = {
  '1110': 'caja',
  '1120': 'banco',
  '1140': 'cobrar',
  '2111': 'proveedores',
  '2113': 'prestamos',
  '3110': 'capital',
}
const allFinanceAccounts: FinanceAccount[] = [
  'caja',
  'banco',
  'cobrar',
  'prestamos',
  'proveedores',
]
const numeric = (amount: number | null | undefined): amount is number =>
  amount != null && Number.isFinite(amount)
const total = (amounts: (number | null)[]): number | null =>
  amounts.every(numeric)
    ? roundMoney(amounts.reduce((sum, amount) => sum + amount, 0))
    : null

function positionValue(
  ledger: FinanceLedger | null | undefined,
  account: FinanceAccount | 'capital',
): number | null {
  if (
    !ledger?.available ||
    !ledger.position.started ||
    ledger.position.missingSales
  )
    return null
  const position = ledger.position
  const opened = (key: FinanceAccount) =>
    position.openedAccounts?.includes(key) ?? true
  if (account === 'capital') {
    if (!allFinanceAccounts.every(opened)) return null
    return numeric(position.capitalNio) ? roundMoney(position.capitalNio) : null
  }
  if (!opened(account)) return null
  const amount =
    account === 'caja' || account === 'banco'
      ? position.cash[account]
      : account === 'cobrar'
        ? position.receivablesNio
        : account === 'prestamos'
          ? position.loansNio
          : position.payablesNio
  return numeric(amount) ? roundMoney(amount) : null
}

type Summary = ReturnType<typeof accountingSummary>
type ResultCode = '4110' | '5120' | '5130' | '5140' | '5150' | '6000'
function reliable(report: ReportData) {
  return (
    report.accounting.available &&
    !!report.ledger &&
    !report.truncated &&
    !report.accounting.truncated
  )
}
function unknownExpenses(report: ReportData) {
  return report.accounting.expenses.some((expense) => {
    if (expense.voidedAt || Object.hasOwn(expenseCategories, expense.category))
      return false
    const day = expense.incurredOn
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day ?? '')
      ? new Date(`${day}T12:00:00Z`)
      : null
    const dated =
      date &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().startsWith(day)
    // Sin fecha válida no podemos asegurar que el gasto quede fuera del corte.
    return !dated || (day >= report.range.from && day <= report.range.to)
  })
}
function netResult(report: ReportData, summary: Summary): number | null {
  return reliable(report) && !unknownExpenses(report)
    ? summary.netProfitNio
    : null
}
function resultAmount(
  report: ReportData,
  summary: Summary,
  code: ResultCode,
): number | null {
  if (!reliable(report)) return null
  if (code === '4110')
    return summary.missingRevenueLines ? null : summary.revenueNio
  if (code === '5120')
    return summary.missingCostUnits ? null : summary.costOfSalesNio
  if (code === '5150')
    return summary.missingWriteOffUnits ? null : summary.inventoryWriteOffNio
  if (unknownExpenses(report)) return null
  const account =
    code === '5130' ? 'ventas' : code === '5140' ? 'financieros' : 'impuestos'
  return (
    summary.expenseByAccount.find((row) => row.account === account)
      ?.amountNio ?? 0
  )
}

export interface AccountingModelInput {
  report: ReportData
  cumulativeReport: ReportData
  openingReport: ReportData | null
  ledger: FinanceLedger
  openingLedger: FinanceLedger | null
  accumulatedFrom: string
  businessName: string
}

/**
 * El catálogo y los cuatro estados comparten estas cifras. Un saldo pendiente
 * permanece null; nunca se usa una diferencia para inventar patrimonio previo.
 */
export function buildAccountingModel({
  report,
  cumulativeReport,
  openingReport,
  ledger,
  openingLedger,
  accumulatedFrom,
  businessName,
}: AccountingModelInput): AccountingModel {
  const period = accountingSummary(report, report.range)
  const cumulative = accountingSummary(cumulativeReport, cumulativeReport.range)
  const opening = openingReport
    ? accountingSummary(openingReport, openingReport.range)
    : null
  const warnings: string[] = []
  const warningsByView: AccountingModel['warningsByView'] = {
    trial: [],
    income: [],
    balance: [],
  }
  const warn = (
    message: string,
    views: (keyof AccountingModel['warningsByView'])[],
  ) => {
    if (!warnings.includes(message)) warnings.push(message)
    for (const view of views)
      if (!warningsByView[view].includes(message))
        warningsByView[view].push(message)
  }
  const resultViews = (
    affectsCumulative: boolean,
  ): (keyof AccountingModel['warningsByView'])[] =>
    affectsCumulative ? ['trial', 'income', 'balance'] : ['trial', 'income']
  const needsEarlierResult = report.range.from > accumulatedFrom
  const resultCodes: ResultCode[] = [
    '4110',
    '5120',
    '5130',
    '5140',
    '5150',
    '6000',
  ]
  const periodResult = Object.fromEntries(
    resultCodes.map((code) => [code, resultAmount(report, period, code)]),
  ) as Record<ResultCode, number | null>
  const cumulativeResult = Object.fromEntries(
    resultCodes.map((code) => [
      code,
      resultAmount(cumulativeReport, cumulative, code),
    ]),
  ) as Record<ResultCode, number | null>
  const openingResult = Object.fromEntries(
    resultCodes.map((code) => [
      code,
      opening && openingReport
        ? resultAmount(openingReport, opening, code)
        : needsEarlierResult
          ? null
          : 0,
    ]),
  ) as Record<ResultCode, number | null>
  const hasSalesTax =
    period.salesTaxNio !== 0 ||
    cumulative.salesTaxNio !== 0 ||
    (opening?.salesTaxNio ?? 0) !== 0
  const catalog = chartOfAccounts.map((row) => ({ ...row }))
  if (hasSalesTax)
    catalog.splice(catalog.findIndex((row) => row.code === '2113') + 1, 0, {
      ...salesTaxAccount,
    })

  const firstOpeningInPeriod =
    !!ledger.position.startOn &&
    ledger.position.startOn >= report.range.from &&
    ledger.position.startOn <= report.range.to
  const turnover = (
    account: FinanceAccount | 'capital',
    side: 'debitNio' | 'creditNio',
  ): number | null => {
    if (
      !ledger.available ||
      !ledger.position.started ||
      ledger.position.missingSales ||
      !ledger.turnovers
    )
      return null
    const end = ledger.turnovers[account]?.[side]
    const noEarlierOpening =
      firstOpeningInPeriod && !openingLedger?.position.started
    const start = noEarlierOpening
      ? 0
      : openingLedger?.available &&
          openingLedger.position.started &&
          !openingLedger.position.missingSales
        ? openingLedger.turnovers?.[account]?.[side]
        : null
    if (!numeric(end) || !numeric(start)) return null
    const difference = roundMoney(end - start)
    // Cumulative gross movement cannot decrease for the same set of records.
    return difference < 0 ? null : difference
  }
  const currentInventory =
    report.range.to === localDay(new Date()) &&
    reliable(cumulativeReport) &&
    !cumulative.unvaluedProducts
      ? cumulative.inventoryCostNio
      : null
  const inventoryDebit = reliable(report) ? period.purchasesNio : null
  const inventoryCredit = total([periodResult['5120'], periodResult['5150']])
  const trial = catalog
    .filter((row) => row.kind === 'account')
    .map((account): TrialRow => {
      const financial = financialCodes[account.code]
      if (financial)
        return {
          code: account.code,
          description: account.description,
          openingNio: positionValue(openingLedger, financial),
          debitNio: turnover(financial, 'debitNio'),
          creditNio: turnover(financial, 'creditNio'),
          closingNio: positionValue(ledger, financial),
        }
      if (account.code === '1130')
        return {
          code: account.code,
          description: account.description,
          openingNio: null,
          debitNio: inventoryDebit,
          creditNio: inventoryCredit,
          closingNio: currentInventory,
        }
      if (account.code === '3190')
        return {
          code: account.code,
          description: account.description,
          openingNio: null,
          debitNio: 0,
          creditNio: 0,
          closingNio: null,
        }
      if (account.code === '2116')
        return {
          code: account.code,
          description: account.description,
          openingNio: null,
          debitNio: null,
          creditNio:
            reliable(report) && !period.missingRevenueLines
              ? period.salesTaxNio
              : null,
          closingNio: null,
        }
      const code = account.code as ResultCode
      return {
        code,
        description: account.description,
        openingNio: openingResult[code],
        debitNio: account.nature === 'debit' ? periodResult[code] : 0,
        creditNio: account.nature === 'credit' ? periodResult[code] : 0,
        closingNio: cumulativeResult[code],
      }
    })
  const signed = (key: 'openingNio' | 'closingNio') =>
    total(
      trial.map((row) => {
        const amount = row[key]
        if (amount === null) return null
        return catalog.find((account) => account.code === row.code)?.nature ===
          'credit'
          ? -amount
          : amount
      }),
    )
  const trialTotals = {
    openingNio: signed('openingNio'),
    debitNio:
      ledger.position.startOn && ledger.position.startOn > report.range.from
        ? null
        : total(trial.map((row) => row.debitNio)),
    creditNio:
      ledger.position.startOn && ledger.position.startOn > report.range.from
        ? null
        : total(trial.map((row) => row.creditNio)),
    closingNio: signed('closingNio'),
  }

  const incomeLine = (code: ResultCode, negative = false): IncomeRow => ({
    code,
    description: catalog.find((row) => row.code === code)!.description,
    kind: 'line',
    periodNio: periodResult[code],
    accumulatedNio: cumulativeResult[code],
    negative,
  })
  const income: IncomeRow[] = [
    {
      code: '4000',
      description: 'Ingresos',
      kind: 'heading',
      periodNio: null,
      accumulatedNio: null,
    },
    incomeLine('4110'),
    {
      code: '',
      description: 'Total ingresos',
      kind: 'subtotal',
      periodNio: periodResult['4110'],
      accumulatedNio: cumulativeResult['4110'],
    },
    {
      code: '5000',
      description: 'Egresos',
      kind: 'heading',
      periodNio: null,
      accumulatedNio: null,
    },
    incomeLine('5120', true),
    {
      code: '',
      description: 'Utilidad bruta',
      kind: 'subtotal',
      periodNio: reliable(report) ? period.grossProfitNio : null,
      accumulatedNio: reliable(cumulativeReport)
        ? cumulative.grossProfitNio
        : null,
    },
    incomeLine('5130', true),
    incomeLine('5140', true),
    incomeLine('5150', true),
    {
      code: '',
      description: 'Total egresos antes de impuestos',
      kind: 'subtotal',
      periodNio: total(
        ['5120', '5130', '5140', '5150'].map(
          (code) => periodResult[code as ResultCode],
        ),
      ),
      accumulatedNio: total(
        ['5120', '5130', '5140', '5150'].map(
          (code) => cumulativeResult[code as ResultCode],
        ),
      ),
      negative: true,
    },
    incomeLine('6000', true),
    {
      code: '',
      description: 'Excedente (déficit)',
      kind: 'total',
      periodNio: netResult(report, period),
      accumulatedNio: netResult(cumulativeReport, cumulative),
    },
  ]

  const row = (
    code: string,
    description: string,
    kind: AccountingRowKind,
    amount: number | null,
  ): BalanceRow => ({ code, description, kind, amount })
  const cash = positionValue(ledger, 'caja')
  const bank = positionValue(ledger, 'banco')
  const receivables = positionValue(ledger, 'cobrar')
  const suppliers = positionValue(ledger, 'proveedores')
  const loans = positionValue(ledger, 'prestamos')
  const liabilities = hasSalesTax ? null : total([suppliers, loans])
  const balance = {
    left: [
      row('1000', 'Activo', 'heading', null),
      row('1100', 'Activo circulante', 'heading', null),
      row('1110', 'Caja de la perfumería', 'line', cash),
      row('1120', 'Bancos de la perfumería', 'line', bank),
      row(
        '1130',
        'Inventario de perfumes a costo promedio',
        'line',
        currentInventory,
      ),
      row('1140', 'Cuentas por cobrar a clientes', 'line', receivables),
      row(
        '',
        'Total activo',
        'total',
        total([cash, bank, currentInventory, receivables]),
      ),
    ],
    right: [
      row('2000', 'Pasivo', 'heading', null),
      row('2100', 'Pasivo circulante', 'heading', null),
      row('2111', 'Proveedores de perfumes', 'line', suppliers),
      row('2113', 'Préstamos por pagar', 'line', loans),
      ...(hasSalesTax
        ? [row('2116', 'Impuesto sobre ventas por conciliar', 'line', null)]
        : []),
      row('', 'Total pasivo', 'subtotal', liabilities),
      row('3000', 'Capital', 'heading', null),
      row(
        '3110',
        'Capital registrado y aportes del dueño',
        'line',
        positionValue(ledger, 'capital'),
      ),
      row(
        '3190',
        'Patrimonio inicial y resultados anteriores por conciliar',
        'line',
        null,
      ),
      row(
        '',
        'Resultado acumulado registrado',
        'line',
        netResult(cumulativeReport, cumulative),
      ),
      row('', 'Total capital', 'subtotal', null),
      row('', 'Total pasivo y capital', 'total', null),
    ],
  }

  if (
    !report.accounting.available ||
    !cumulativeReport.accounting.available ||
    !report.ledger ||
    !cumulativeReport.ledger
  )
    warn(
      'Los datos contables no están disponibles; los importes dependientes quedan pendientes.',
      resultViews(
        !cumulativeReport.accounting.available || !cumulativeReport.ledger,
      ),
    )
  if (
    openingReport &&
    (!openingReport.accounting.available || !openingReport.ledger)
  )
    warn(
      'Los datos contables del corte inicial no están disponibles; sus saldos quedan pendientes.',
      ['trial'],
    )
  if (
    report.truncated ||
    report.accounting.truncated ||
    cumulativeReport.truncated ||
    cumulativeReport.accounting.truncated
  )
    warn(
      'La consulta contiene datos parciales; los totales afectados quedan pendientes.',
      resultViews(
        cumulativeReport.truncated || cumulativeReport.accounting.truncated,
      ),
    )
  if (openingReport?.truncated || openingReport?.accounting.truncated)
    warn(
      'La consulta del corte inicial contiene datos parciales; sus saldos quedan pendientes.',
      ['trial'],
    )
  if (period.missingRevenueLines || cumulative.missingRevenueLines)
    warn(
      'Hay ventas sin importes históricos completos; sus ingresos y resultados quedan pendientes.',
      resultViews(!!cumulative.missingRevenueLines),
    )
  if (opening?.missingRevenueLines)
    warn(
      'Hay ventas sin importes históricos completos en el corte inicial; sus ingresos quedan pendientes.',
      ['trial'],
    )
  if (period.missingCostUnits || cumulative.missingCostUnits)
    warn(
      'Hay perfumes vendidos sin costo histórico; el costo de venta y la utilidad quedan pendientes.',
      resultViews(!!cumulative.missingCostUnits),
    )
  if (opening?.missingCostUnits)
    warn(
      'Hay perfumes vendidos sin costo histórico en el corte inicial; su costo de venta queda pendiente.',
      ['trial'],
    )
  if (period.missingWriteOffUnits || cumulative.missingWriteOffUnits)
    warn(
      'Hay mermas o salidas sin costo histórico; su importe y la utilidad quedan pendientes.',
      resultViews(!!cumulative.missingWriteOffUnits),
    )
  if (opening?.missingWriteOffUnits)
    warn(
      'Hay mermas o salidas sin costo histórico en el corte inicial; su importe queda pendiente.',
      ['trial'],
    )
  if (!ledger.available || !ledger.position.started)
    warn(
      'Faltan los saldos iniciales de caja, bancos, clientes, proveedores y préstamos.',
      ['trial', 'balance'],
    )
  else if (
    allFinanceAccounts.some(
      (account) => !(ledger.position.openedAccounts?.includes(account) ?? true),
    )
  )
    warn(
      'Algunas cuentas no tienen un saldo inicial explícito; sus saldos quedan pendientes.',
      ['trial', 'balance'],
    )
  if (ledger.position.missingSales || openingLedger?.position.missingSales)
    warn(
      'Faltan importes de facturas que mueven el dinero; los saldos y movimientos financieros quedan pendientes.',
      ledger.position.missingSales ? ['trial', 'balance'] : ['trial'],
    )
  if (ledger.position.startOn && ledger.position.startOn > report.range.from)
    warn(
      `Los movimientos financieros empiezan con la apertura del ${ledger.position.startOn}; no incluyen operaciones anteriores a esa fecha.`,
      ['trial'],
    )
  if (
    !ledger.turnovers ||
    (!firstOpeningInPeriod &&
      (!openingLedger?.available ||
        !openingLedger.position.started ||
        !openingLedger.turnovers))
  )
    warn(
      'No se dispone de movimientos completos entre ambos cortes para calcular el debe y el haber financieros.',
      ['trial'],
    )
  if (needsEarlierResult && !openingReport)
    warn(
      'Falta el reporte anterior al período para calcular los saldos iniciales de ingresos y egresos.',
      ['trial'],
    )
  if (cumulative.unvaluedProducts)
    warn(
      'Hay perfumes en existencia sin costo promedio; el inventario queda pendiente.',
      ['trial', 'balance'],
    )
  const currentCut = report.range.to === localDay(new Date())
  warn(
    currentCut
      ? 'El inventario final usa las existencias actuales; el inventario inicial histórico queda pendiente.'
      : 'El inventario histórico al corte y al inicio del período todavía no se reconstruye.',
    ['trial'],
  )
  if (!currentCut)
    warn('El inventario histórico al corte todavía no se reconstruye.', [
      'balance',
    ])
  warn(
    'El patrimonio inicial y los resultados anteriores están por conciliar; los saldos totales de la balanza quedan pendientes.',
    ['trial'],
  )
  warn(
    'Estado de situación financiera provisional: el patrimonio inicial y los resultados anteriores están por conciliar. Los totales de capital y de pasivo más capital quedan pendientes.',
    ['balance'],
  )
  if (hasSalesTax)
    warn(
      'Existen impuestos sobre ventas registrados; su saldo por pagar requiere conciliar aperturas y pagos. No se incluyen como ingresos.',
      ['trial', 'balance'],
    )
  if (unknownExpenses(report) || unknownExpenses(cumulativeReport))
    warn(
      'Hay gastos con categorías desconocidas; los gastos y la utilidad afectados quedan pendientes.',
      resultViews(unknownExpenses(cumulativeReport)),
    )
  if (openingReport && unknownExpenses(openingReport))
    warn(
      'Hay gastos con categorías desconocidas en el corte inicial; sus saldos de gasto quedan pendientes.',
      ['trial'],
    )
  return {
    businessName,
    range: report.range,
    accumulatedFrom,
    catalog,
    trial,
    trialTotals,
    income,
    balance,
    warnings,
    warningsByView,
  }
}
