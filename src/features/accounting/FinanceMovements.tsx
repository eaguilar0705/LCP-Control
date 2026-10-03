import { useCallback, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import type { Currency } from '../../lib/domain'
import {
  categoriesOf,
  expenseAccountOrder,
  expenseAccounts,
  expenseLabel,
  roundMoney,
  type ExpenseAccount,
  type ExpenseCategory,
  type ExpenseInput,
} from '../reports/accounting'
import {
  localDay,
  presetLabels,
  presetRange,
  type Preset,
  type ReportRange,
} from '../reports/model'
import {
  financeAccounts,
  financeKindOrder,
  financeKinds,
  moneyAccountOrder,
  moneyAccounts,
  reducesLoan,
  toNio,
  type FinanceAccount,
  type FinanceEntryInput,
  type FinanceKind,
  type FinanceLedger,
  type MoneyAccount,
} from './finance'

const money = (amount: number) => formatCurrency(amount, 'NIO')
const roundRate = (value: number) => Math.round(value * 1e6) / 1e6
/** Una fila de la lista: un movimiento del contador o un gasto. */
interface Row {
  id: string
  source: 'entry' | 'expense'
  day: string
  createdAt: string
  type: string
  detail: string
  account: string
  amountNio: number
  /** Positivo si entra dinero o baja una deuda a favor; negativo si sale. */
  sign: 1 | -1 | 0
  voidReason: string | null
}
type Action = { kind: 'record' } | { kind: 'void'; row: Row }

/** Si el movimiento suma o resta en la cuenta que se muestra en la fila. */
const entrySign = (kind: FinanceKind): Row['sign'] =>
  kind === 'withdrawal' || kind === 'supplier_payment'
    ? -1
    : kind === 'transfer'
      ? 0
      : 1

function rowsOf(ledger: FinanceLedger): Row[] {
  const entries = ledger.entries.map(
    (entry): Row => ({
      id: entry.id,
      source: 'entry',
      day: entry.occurredOn,
      createdAt: entry.createdAt,
      type: financeKinds[entry.kind],
      detail: [entry.counterparty, entry.description].filter(Boolean).join(' · '),
      account: entry.toAccount
        ? `${financeAccounts[entry.account]} → ${moneyAccounts[entry.toAccount]}`
        : financeAccounts[entry.account],
      amountNio: toNio(entry),
      sign: entrySign(entry.kind),
      voidReason: entry.voidedAt ? (entry.voidReason ?? '') : null,
    }),
  )
  const expenses = ledger.expenses.map(
    (expense): Row => ({
      id: expense.id,
      source: 'expense',
      day: expense.incurredOn,
      createdAt: expense.createdAt,
      type: reducesLoan(expense)
        ? `Pago de préstamo · ${expenseLabel(expense.category)}`
        : (expenseLabel(expense.category) ?? 'Gasto'),
      detail: expense.description,
      account: moneyAccounts[expense.account] ?? expense.account,
      amountNio: toNio(expense),
      sign: -1,
      voidReason: expense.voidedAt ? (expense.voidReason ?? '') : null,
    }),
  )
  return [...entries, ...expenses].sort(
    (a, b) =>
      b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt),
  )
}

/**
 * Movimientos: los saldos de caja, bancos y deudas al fin del período, y lo
 * que el contador registró en él. Las ventas, compras y gastos mueven los
 * saldos solos; aquí se teclea lo demás.
 */
export function FinanceMovements() {
  const { demo, role } = useAccess()
  const { financeService } = useServices()
  const [preset, setPreset] = useState<Preset>('30d')
  const [range, setRange] = useState<ReportRange>(() => presetRange('30d'))
  const [action, setAction] = useState<Action | null>(null)
  const [message, setMessage] = useState('')
  const load = useCallback(
    () => financeService.getLedger(range),
    [financeService, range],
  )
  const { data, loading, error, retry } = useQuery(load)
  const writable = !demo && can(role, 'finance.read') && !!data?.available
  const rows = data ? rowsOf(data) : []
  const position = data?.position
  const balance = (amount: number | undefined) =>
    !position?.started || amount === undefined ? '—' : money(amount)
  return (
    <>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Movimientos</h2>
          <Button
            disabled={!writable}
            onClick={() => {
              setMessage('')
              setAction({ kind: 'record' })
            }}
          >
            <Plus size={17} />
            Registrar
          </Button>
        </div>
        <div className="filter-grid">
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
          <>
            {!data.available && (
              <p className="inline-error" role="alert">
                Falta aplicar la actualización de contabilidad en la base de
                datos.
              </p>
            )}
            {data.available && !position?.started && (
              <p className="accounting-callout" role="status">
                Registra el saldo inicial de caja y banco.
              </p>
            )}
            {position?.started && position.missingSales > 0 && (
              <p className="accounting-callout" role="status">
                {position.missingSales} factura(s) sin importe contable.
              </p>
            )}
            <div className="finance-balances" aria-label="Saldos al fin del período">
              {moneyAccountOrder.map((account) => (
                <div className="accounting-metric" key={account}>
                  <span>{moneyAccounts[account]}</span>
                  <strong>{balance(position?.cash[account])}</strong>
                </div>
              ))}
              <div className="accounting-metric">
                <span>Por cobrar</span>
                <strong>{balance(position?.receivablesNio)}</strong>
              </div>
              <div className="accounting-metric">
                <span>Préstamos</span>
                <strong>{balance(position?.loansNio)}</strong>
              </div>
              <div className="accounting-metric">
                <span>Proveedores</span>
                <strong>{balance(position?.payablesNio)}</strong>
              </div>
            </div>
            <p className="accounting-note">
              Al {formatDate(range.to)}
              {position?.startOn
                ? ` · desde el ${formatDate(position.startOn)}`
                : ''}
            </p>
            {rows.length === 0 ? (
              <EmptyState title="Sin movimientos en este período" />
            ) : (
              <div
                className="accounting-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Movimientos del período"
              >
                <table className="accounting-table">
                  <caption className="sr-only">Movimientos del período</caption>
                  <thead>
                    <tr>
                      <th scope="col">Fecha / tipo</th>
                      <th scope="col">Detalle</th>
                      <th scope="col">Cuenta</th>
                      <th scope="col" className="num">
                        Importe C$
                      </th>
                      <th scope="col">
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={`${row.source}:${row.id}`}
                        className={
                          row.voidReason !== null ? 'accounting-voided' : undefined
                        }
                      >
                        <th scope="row">
                          {formatDate(row.day)}
                          <small>{row.type}</small>
                        </th>
                        <td>{row.detail || '—'}</td>
                        <td>{row.account}</td>
                        <td className="num">
                          {row.sign < 0 ? `(${money(row.amountNio)})` : money(row.amountNio)}
                        </td>
                        <td>
                          {row.voidReason !== null ? (
                            <>
                              <Badge>Anulado</Badge>
                              <small>{row.voidReason}</small>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              disabled={!writable}
                              aria-label={`Anular ${row.type} del ${formatDate(row.day)}`}
                              onClick={() => {
                                setMessage('')
                                setAction({ kind: 'void', row })
                              }}
                            >
                              Anular
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      {action?.kind === 'record' && (
        <RecordDialog
          onClose={() => setAction(null)}
          onRecorded={(text) => {
            setAction(null)
            setMessage(text)
            retry()
          }}
        />
      )}
      {action?.kind === 'void' && (
        <VoidDialog
          row={action.row}
          onClose={() => setAction(null)}
          onVoided={() => {
            setAction(null)
            setMessage('Movimiento anulado.')
            retry()
          }}
        />
      )}
    </>
  )
}

/** Lo que se puede registrar: un gasto o uno de los movimientos del contador. */
type RecordKind = FinanceKind | 'expense'
const recordKinds: Record<RecordKind, string> = {
  expense: 'Gasto',
  ...financeKinds,
}
/** Rótulo de la cuenta según el tipo: de dónde sale o a dónde entra el dinero. */
const accountLabel: Record<RecordKind, string> = {
  expense: 'Pagado desde',
  opening: 'Cuenta',
  capital: 'Entra a',
  withdrawal: 'Sale de',
  transfer: 'Desde',
  loan: 'Entra a',
  supplier_payment: 'Pagado desde',
  collection: 'Entra a',
}
const counterpartyLabel: Partial<Record<RecordKind, string>> = {
  loan: 'Acreedor',
  supplier_payment: 'Proveedor',
  collection: 'Cliente',
}

function RecordDialog({
  onClose,
  onRecorded,
}: {
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { accountingService, financeService, settingsService } = useServices()
  const { data: savedRate } = useQuery(settingsService.getExchangeRate)
  const [entryOperation] = useState(() =>
    createIdempotentOperation<Omit<FinanceEntryInput, 'requestId'>, unknown>(
      financeService.recordEntry,
    ),
  )
  const [expenseOperation] = useState(() =>
    createIdempotentOperation<Omit<ExpenseInput, 'requestId'>, unknown>(
      accountingService.recordExpense,
    ),
  )
  const today = localDay(new Date())
  const [kind, setKind] = useState<RecordKind>('expense')
  const [account, setAccount] = useState<FinanceAccount>('caja')
  const [toAccount, setToAccount] = useState<MoneyAccount>('banco')
  const [expenseAccount, setExpenseAccount] = useState<ExpenseAccount>('ventas')
  const [category, setCategory] = useState<ExpenseCategory>('renta')
  const [occurredOn, setOccurredOn] = useState(today)
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [rateText, setRateText] = useState('')
  const [amountText, setAmountText] = useState('')
  const [counterparty, setCounterparty] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const rate =
    currency === 'NIO'
      ? 1
      : Number(rateText || (savedRate ? String(savedRate.usdToNio) : ''))
  const amount = Number(amountText)
  const accounts: FinanceAccount[] =
    kind === 'opening'
      ? (Object.keys(financeAccounts) as FinanceAccount[])
      : moneyAccountOrder
  const shownAccount = accounts.includes(account) ? account : 'caja'
  const destination =
    toAccount === shownAccount
      ? moneyAccountOrder.find((id) => id !== shownAccount)!
      : toAccount
  const needsDescription = kind === 'expense'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setFailure('')
    if (!occurredOn || occurredOn > today) {
      setFailure('Elige una fecha que no sea futura.')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setFailure('El importe debe ser mayor que cero.')
      return
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setFailure('Indica el tipo de cambio.')
      return
    }
    if (needsDescription && description.trim().length < 3) {
      setFailure('Describe el gasto.')
      return
    }
    setBusy(true)
    try {
      if (kind === 'expense') {
        await expenseOperation.execute({
          incurredOn: occurredOn,
          category,
          description: description.trim(),
          amount: roundMoney(amount),
          currency,
          exchangeRate: roundRate(rate),
          reference: reference.trim(),
          account: shownAccount as MoneyAccount,
        })
        onRecorded('Gasto registrado.')
      } else {
        await entryOperation.execute({
          occurredOn,
          kind,
          account: shownAccount,
          toAccount: kind === 'transfer' ? destination : null,
          amount: roundMoney(amount),
          currency,
          exchangeRate: roundRate(rate),
          counterparty: counterparty.trim(),
          description: description.trim(),
          reference: reference.trim(),
        })
        onRecorded(`Registrado: ${financeKinds[kind].toLowerCase()}.`)
      }
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title="Registrar movimiento"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form className="accounting-form" onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          <div className="form-grid">
            <Select
              label="Tipo"
              value={kind}
              onChange={(event) => setKind(event.target.value as RecordKind)}
            >
              {(['expense', ...financeKindOrder] as RecordKind[]).map((id) => (
                <option key={id} value={id}>
                  {recordKinds[id]}
                </option>
              ))}
            </Select>
            <Input
              label="Fecha"
              type="date"
              max={today}
              required
              value={occurredOn}
              onChange={(event) => setOccurredOn(event.target.value)}
            />
            {kind === 'expense' && (
              <>
                <Select
                  label="Cuenta de gasto"
                  value={expenseAccount}
                  onChange={(event) => {
                    const next = event.target.value as ExpenseAccount
                    setExpenseAccount(next)
                    setCategory(categoriesOf(next)[0])
                  }}
                >
                  {expenseAccountOrder
                    .filter((id) => id !== 'operativos')
                    .map((id) => (
                      <option key={id} value={id}>
                        {expenseAccounts[id].label}
                      </option>
                    ))}
                </Select>
                <Select
                  label="Categoría"
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as ExpenseCategory)
                  }
                >
                  {categoriesOf(expenseAccount).map((id) => (
                    <option key={id} value={id}>
                      {expenseLabel(id)}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <Select
              label={accountLabel[kind]}
              value={shownAccount}
              onChange={(event) =>
                setAccount(event.target.value as FinanceAccount)
              }
            >
              {accounts.map((id) => (
                <option key={id} value={id}>
                  {financeAccounts[id]}
                </option>
              ))}
            </Select>
            {kind === 'transfer' && (
              <Select
                label="Hacia"
                value={destination}
                onChange={(event) =>
                  setToAccount(event.target.value as MoneyAccount)
                }
              >
                {moneyAccountOrder
                  .filter((id) => id !== shownAccount)
                  .map((id) => (
                    <option key={id} value={id}>
                      {moneyAccounts[id]}
                    </option>
                  ))}
              </Select>
            )}
            {counterpartyLabel[kind] && (
              <Input
                label={counterpartyLabel[kind]}
                maxLength={160}
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
              />
            )}
            <Select
              label="Moneda"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as Currency)}
            >
              <option value="NIO">Córdobas</option>
              <option value="USD">Dólares</option>
            </Select>
            {currency === 'USD' && (
              <Input
                label="Tipo de cambio"
                type="number"
                min="0.000001"
                step="0.000001"
                required
                value={rateText || (savedRate ? String(savedRate.usdToNio) : '')}
                onChange={(event) => setRateText(event.target.value)}
              />
            )}
            <Input
              label={`Importe (${currency})`}
              type="number"
              min="0.01"
              step="0.01"
              required
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
            />
            <Input
              label="Referencia"
              maxLength={200}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
          <Input
            label="Descripción"
            maxLength={300}
            required={needsDescription}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="accounting-form-total">
            <span>En córdobas</span>
            <strong>
              {Number.isFinite(amount) && amount > 0 && rate > 0
                ? money(roundMoney(amount * rate))
                : '—'}
            </strong>
          </div>
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
          <div className="form-actions">
            <Button type="submit" aria-busy={busy}>
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}

function VoidDialog({
  row,
  onClose,
  onVoided,
}: {
  row: Row
  onClose: () => void
  onVoided: () => void
}) {
  const { accountingService, financeService } = useServices()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (reason.trim().length < 5) {
      setFailure('Indica el motivo.')
      return
    }
    setBusy(true)
    setFailure('')
    try {
      if (row.source === 'expense')
        await accountingService.voidExpense(row.id, reason.trim())
      else await financeService.voidEntry(row.id, reason.trim())
      onVoided()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={`Anular ${row.type.toLowerCase()}`}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form className="accounting-form" onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          <p>
            {formatDate(row.day)} · {money(row.amountNio)}
          </p>
          <Input
            label="Motivo"
            required
            minLength={5}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
          <div className="form-actions">
            <Button type="submit" aria-busy={busy}>
              {busy ? 'Anulando…' : 'Anular'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}
