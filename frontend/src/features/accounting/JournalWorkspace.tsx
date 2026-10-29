import {
  useCallback,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  Button,
  Card,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { AppError, errorMessage } from '../../lib/errors'
import { useCanVoid } from './financeAccess'
import { useAccess } from '../../app/AccessContext'
import {
  getPendingJournal,
  setPendingJournal,
  subscribePendingJournal,
  pendingJournalRevision,
  type JournalSubmission,
} from './pendingJournal'
import { formatCurrency, formatDate } from '../../lib/format'
import { localDay } from '../reports/model'
import {
  cardSettlement,
  accountAcceptsCurrency,
  journalTotals,
  journalNumber,
  isAutomaticJournal,
  type JournalLine,
  type LedgerReport,
} from './journalModel'
import { journalRpc, readJournalPage } from './journalService'
import { useQuery } from '../../lib/useQuery'
import { getOperationReferences } from '../../lib/operationRecovery'
import { JournalDetail } from './JournalDetail'

const journalKinds = {
  opening: 'Saldos iniciales',
  income: 'Comprobante de ingreso',
  expense: 'Comprobante de egreso',
  deposit: 'Minuta de depósito',
  transfer: 'Transferencia bancaria',
  card_settlement: 'Liquidación de tarjetas',
  adjustment: 'Comprobante de ajuste',
} as const
const automaticKinds = { sales: 'Ventas', sales_cost: 'Costo de ventas' }
type Kind = keyof typeof journalKinds
type Line = JournalLine
export function JournalWorkspace({
  data,
  onChanged,
}: {
  data: LedgerReport
  onChanged: () => void
}) {
  const canVoid = useCanVoid()
  const { storageScope = 'anonymous' } = useAccess()
  useSyncExternalStore(subscribePendingJournal, pendingJournalRevision)
  const [action, setAction] = useState<Kind | null>(
    () => getPendingJournal(storageScope)?.kind ?? null,
  )
  const [voidId, setVoidId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pageState, setPageState] = useState<{
    source: LedgerReport
    offset: number
    asOf: string
    total: number
  } | null>(null)
  const paging = pageState?.source === data ? pageState : null
  const offset = paging?.offset ?? 0
  const loadPage = useCallback(
    () =>
      readJournalPage(
        data.from,
        data.to,
        offset,
        paging?.asOf ?? null,
        paging?.total ?? null,
      ),
    [data, offset, paging?.asOf, paging?.total],
  )
  const history = useQuery(loadPage)
  const currentPage =
    history.data?.offset === offset &&
    history.data.from === data.from &&
    history.data.to === data.to
  const entries = currentPage ? history.data!.entries : []
  async function cancel(e: FormEvent) {
    e.preventDefault()
    if (!voidId || busy) return
    setBusy(true)
    setError('')
    try {
      await journalRpc('void_journal_entry', { p_id: voidId, p_reason: reason })
      setVoidId(null)
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="accounting-card">
      <div className="section-heading">
        <h2>Comprobantes</h2>
      </div>
      <div className="journal-actions">
        {(Object.keys(journalKinds) as Kind[])
          .filter(
            (k) =>
              k !== 'deposit' &&
              (data.startOn ? k !== 'opening' : k === 'opening'),
          )
          .map((kind) => (
            <Button
              key={kind}
              variant="secondary"
              onClick={() => setAction(kind)}
            >
              <Plus size={16} />
              {journalKinds[kind]}
            </Button>
          ))}
      </div>
      {history.error && (
        <ErrorState
          message={history.error}
          retry={() => {
            setPageState(null)
            history.retry()
          }}
        />
      )}
      {!history.error && !currentPage && <LoadingState />}
      <div
        className="accounting-table-scroll"
        aria-busy={!currentPage && !history.error}
      >
        <table className="accounting-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th>Referencia</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <Button variant="ghost" onClick={() => setDetailId(e.id)}>
                    {journalNumber(e)}
                  </Button>
                </td>
                <td>{formatDate(e.occurred_on)}</td>
                <th scope="row">
                  {journalKinds[e.kind as Kind] ??
                    automaticKinds[e.kind as keyof typeof automaticKinds] ??
                    e.kind}
                  <small>{e.description}</small>
                </th>
                <td>{e.reference || '—'}</td>
                <td>
                  {isAutomaticJournal(e) ? (
                    e.missingSales > 0 ? (
                      'Detalle pendiente'
                    ) : e.missingCosts > 0 ? (
                      'Costo pendiente'
                    ) : (
                      'Automático'
                    )
                  ) : e.voided_at ? (
                    'Anulado'
                  ) : e.kind === 'opening' ? (
                    'Registrado'
                  ) : canVoid ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setVoidId(e.id)
                        setReason('')
                        setError('')
                      }}
                    >
                      Anular
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {currentPage && !history.error && history.data!.total === 0 && (
        <p>Sin comprobantes en este período.</p>
      )}
      {currentPage && !history.error && history.data!.total > 0 && (
        <nav className="form-actions" aria-label="Páginas de comprobantes">
          <Button
            type="button"
            variant="secondary"
            disabled={offset === 0}
            onClick={() =>
              setPageState({
                source: data,
                offset: Math.max(0, offset - 50),
                asOf: history.data!.asOf,
                total: history.data!.total,
              })
            }
          >
            Anterior
          </Button>
          <span role="status">
            {offset + 1}–
            {Math.min(offset + entries.length, history.data!.total)} de{' '}
            {history.data!.total} comprobantes
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={offset + entries.length >= history.data!.total}
            onClick={() =>
              setPageState({
                source: data,
                offset: offset + 50,
                asOf: history.data!.asOf,
                total: history.data!.total,
              })
            }
          >
            Siguiente
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={offset + entries.length >= history.data!.total}
            onClick={() =>
              setPageState({
                source: data,
                offset: Math.floor((history.data!.total - 1) / 50) * 50,
                asOf: history.data!.asOf,
                total: history.data!.total,
              })
            }
          >
            Última
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPageState(null)
              history.retry()
            }}
          >
            Actualizar comprobantes
          </Button>
        </nav>
      )}
      {action && (
        <JournalDialog
          kind={action}
          data={data}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null)
            onChanged()
          }}
        />
      )}
      {detailId && (
        <JournalDetail
          id={detailId}
          entry={
            entries.find((e) => e.id === detailId && isAutomaticJournal(e)) as
              import('./journalModel').AutomaticJournalRecord | undefined
          }
          onClose={() => setDetailId(null)}
        />
      )}
      {voidId && (
        <Dialog
          open
          title="Anular comprobante"
          onClose={() => {
            if (!busy) setVoidId(null)
          }}
        >
          <form className="day-form" onSubmit={cancel}>
            <Input
              label="Motivo"
              value={reason}
              maxLength={500}
              required
              onChange={(e) => setReason(e.target.value)}
            />
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <Button variant="danger" disabled={busy}>
              Confirmar anulación
            </Button>
          </form>
        </Dialog>
      )}
    </Card>
  )
}
function JournalDialog({
  kind,
  data,
  onClose,
  onSaved,
}: {
  kind: Kind
  data: LedgerReport
  onClose: () => void
  onSaved: () => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const [restored] = useState(() => getPendingJournal(storageScope))
  const [pending, setPending] = useState<JournalSubmission | null>(restored)
  const [date, setDate] = useState(restored?.occurredOn ?? localDay(new Date()))
  const [description, setDescription] = useState(restored?.description ?? '')
  const [reference, setReference] = useState(restored?.reference ?? '')
  const [currency, setCurrency] = useState<'NIO' | 'USD'>(
    restored?.currency ?? 'NIO',
  )
  const [rate, setRate] = useState(
    restored ? String(restored.exchangeRate) : '',
  )
  const [lines, setLines] = useState<Line[]>(
    restored?.lines ?? [
      { account: '', debit: 0, credit: 0 },
      { account: '', debit: 0, credit: 0 },
    ],
  )
  const [amount, setAmount] = useState(
    restored ? String(restored.gross ?? restored.lines[0]?.debit ?? '') : '',
  )
  const [origin, setOrigin] = useState(restored?.lines.at(-1)?.account ?? '')
  const [destination, setDestination] = useState(
    restored?.bankAccount ?? restored?.lines[0]?.account ?? '',
  )
  const [commission, setCommission] = useState(
    restored?.commissionRate?.toString() ?? '',
  )
  const [withholding, setWithholding] = useState(
    restored?.withholdingRate?.toString() ?? '',
  )
  const [withholdingBase, setWithholdingBase] = useState<
    'gross' | 'net_commission'
  >(restored?.withholdingBase ?? 'gross')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(
    restored
      ? 'Verifica el guardado pendiente antes de registrar otro comprobante.'
      : '',
  )
  const simple =
    kind === 'transfer' || kind === 'deposit' || kind === 'card_settlement'
  const accounts = data.accounts.filter(
    (a) =>
      a.postable &&
      (kind !== 'opening' ||
        ['asset', 'liability', 'equity'].includes(a.bucket)) &&
      (kind === 'opening' || accountAcceptsCurrency(a.code, currency)),
  )
  const bankAccounts = accounts.filter((a) => a.code.startsWith('1120-'))
  let settlement: ReturnType<typeof cardSettlement> | null = null
  let settlementError = ''
  try {
    if (
      kind === 'card_settlement' &&
      amount !== '' &&
      commission !== '' &&
      withholding !== ''
    )
      settlement = cardSettlement(
        Number(amount),
        Number(commission),
        Number(withholding),
        withholdingBase,
      )
  } catch (e) {
    settlementError = e instanceof Error ? e.message : errorMessage(e)
  }
  const activeLines: Line[] = simple
    ? kind === 'card_settlement'
      ? settlement
        ? [
            { account: destination, debit: settlement.net, credit: 0 },
            { account: '5140-001', debit: settlement.commission, credit: 0 },
            { account: '1340', debit: settlement.withholding, credit: 0 },
            { account: '1142', debit: 0, credit: Number(amount) },
          ].filter((l) => l.debit || l.credit)
        : []
      : [
          { account: destination, debit: Number(amount), credit: 0 },
          {
            account:
              kind === 'deposit'
                ? currency === 'NIO'
                  ? '1110-001'
                  : '1110-002'
                : origin,
            debit: 0,
            credit: Number(amount),
          },
        ]
    : lines
  const exchangeRate = currency === 'NIO' ? 1 : Number(rate)
  const {
    debit,
    credit,
    debitNio,
    creditNio,
    roundingNio,
    valid: balanced,
  } = journalTotals(
    activeLines,
    exchangeRate,
    kind === 'card_settlement' && currency === 'USD'
      ? { roundingAccount: destination }
      : undefined,
  )
  const valid =
    balanced &&
    activeLines.every((l) => accounts.some((a) => a.code === l.account)) &&
    (!simple || activeLines[0].account !== activeLines.at(-1)?.account)
  function update(index: number, key: keyof Line, value: string) {
    setError('')
    setLines((old) =>
      old.map((l, i) =>
        i === index
          ? { ...l, [key]: key === 'account' ? value : Number(value) }
          : l,
      ),
    )
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (
      getOperationReferences(storageScope).some(
        (reference) =>
          reference.kind === 'journal' &&
          reference.requestId !== pending?.requestId,
      )
    ) {
      setError(
        'Hay un comprobante anterior por verificar. Consulta el aviso de recuperación antes de registrar otro.',
      )
      return
    }
    if (!pending && !valid) {
      setError(
        settlementError ||
          (simple && origin && origin === destination
            ? 'Selecciona bancos distintos para el origen y el destino.'
            : debit !== credit
              ? 'El Debe y el Haber deben sumar lo mismo. Revisa los importes.'
              : debitNio !== creditNio
                ? 'El Debe y el Haber deben coincidir también en córdobas. Revisa el tipo de cambio y los importes.'
                : 'Completa las cuentas y registra un importe positivo en el Debe o el Haber de cada renglón.'),
      )
      return
    }
    setBusy(true)
    setError('')
    const payload: JournalSubmission = pending ?? {
      requestId: crypto.randomUUID(),
      occurredOn: date,
      kind,
      description,
      reference,
      currency,
      exchangeRate,
      lines: activeLines,
      ...(kind === 'card_settlement'
        ? {
            gross: Number(amount),
            commissionRate: Number(commission),
            withholdingRate: Number(withholding),
            withholdingBase,
            bankAccount: destination,
          }
        : {}),
    }
    setPending(payload)
    try {
      setPendingJournal(storageScope, payload)
      await journalRpc('record_journal_entry', {
        p_input: payload,
      })
      setPendingJournal(storageScope, null)
      setPending(null)
      onSaved()
    } catch (e) {
      // Una denegación o límite del reintento no confirma el resultado de la
      // primera solicitud. Su UUID sigue pendiente hasta verificarlo.
      if (
        e instanceof AppError &&
        (e.kind === 'validation' ||
          (!pending &&
            ['unauthorized', 'rate_limited', 'configuration'].includes(e.kind)))
      ) {
        setPendingJournal(storageScope, null)
        setPending(null)
      }
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={journalKinds[kind]}
      className="journal-dialog"
      dismissible={!busy && !pending}
      onClose={() => {
        if (pending) {
          setError(
            'Verifica primero el guardado pendiente con «Verificar guardado» para evitar duplicar el comprobante.',
          )
          return
        }
        if (!busy) onClose()
      }}
    >
      <form
        className="day-form"
        onSubmit={save}
        onChange={() => {
          if (!pending) setError('')
        }}
      >
        <fieldset
          className="journal-entry-fields"
          disabled={busy || pending !== null}
        >
          <div className="journal-fields">
            <Input
              label="Fecha"
              type="date"
              required
              max={localDay(new Date())}
              min={kind === 'opening' ? undefined : (data.startOn ?? undefined)}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <Input
              label="Referencia / número de documento"
              maxLength={200}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <Select
              label="Moneda"
              value={currency}
              onChange={(e) => {
                const next = e.target.value as 'NIO' | 'USD'
                setCurrency(next)
                if (kind !== 'opening') {
                  setLines((old) =>
                    old.map((line) => ({
                      ...line,
                      account: accountAcceptsCurrency(line.account, next)
                        ? line.account
                        : '',
                    })),
                  )
                  setOrigin((old) =>
                    accountAcceptsCurrency(old, next) ? old : '',
                  )
                  setDestination((old) =>
                    accountAcceptsCurrency(old, next) ? old : '',
                  )
                }
              }}
            >
              <option value="NIO">Córdobas</option>
              <option value="USD">Dólares</option>
            </Select>
            {currency === 'USD' && (
              <Input
                label="Tipo de cambio"
                type="number"
                min="0.000001"
                max="1000"
                step="0.000001"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            )}
          </div>
          <Input
            label="Concepto"
            required
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {kind === 'opening' && (
            <p>
              Saldos al inicio de la fecha seleccionada. Registra únicamente
              activo, pasivo y capital; los ingresos y gastos comienzan con las
              operaciones.
            </p>
          )}
          {simple ? (
            <>
              <div className="journal-fields">
                {kind === 'transfer' && (
                  <Select
                    label="Banco de origen"
                    required
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                  >
                    <option value="">Seleccionar</option>
                    {bankAccounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
                <Select
                  label={
                    kind === 'card_settlement'
                      ? 'Banco que acredita'
                      : 'Banco de destino'
                  }
                  required
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Seleccionar</option>
                  {bankAccounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <Input
                  label={
                    kind === 'card_settlement'
                      ? 'Venta bruta liquidada'
                      : 'Importe'
                  }
                  type="number"
                  required
                  min="0.01"
                  max="100000000"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {kind === 'card_settlement' && (
                  <>
                    <Input
                      label="Comisión bancaria (%)"
                      type="number"
                      min="0"
                      max="100"
                      step="0.0001"
                      required
                      value={commission}
                      onChange={(e) => setCommission(e.target.value)}
                    />
                    <Input
                      label="Retención IR (%)"
                      type="number"
                      min="0"
                      max="100"
                      step="0.0001"
                      required
                      value={withholding}
                      onChange={(e) => setWithholding(e.target.value)}
                    />
                    <Select
                      label="Base de retención"
                      value={withholdingBase}
                      onChange={(e) =>
                        setWithholdingBase(
                          e.target.value as 'gross' | 'net_commission',
                        )
                      }
                    >
                      <option value="gross">Venta bruta</option>
                      <option value="net_commission">
                        Venta menos comisión
                      </option>
                    </Select>
                  </>
                )}
              </div>
              {settlement && (
                <div className="day-closing">
                  Comisión: {formatCurrency(settlement.commission, currency)} ·
                  Retención acreditable:{' '}
                  {formatCurrency(settlement.withholding, currency)}
                  <p>
                    <strong>
                      Neto a acreditar:{' '}
                      {formatCurrency(settlement.net, currency)}
                    </strong>
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="journal-lines">
                {lines.map((l, i) => (
                  <div className="journal-line" key={i}>
                    <Select
                      label={`Cuenta ${i + 1}`}
                      required
                      value={l.account}
                      onChange={(e) => update(i, 'account', e.target.value)}
                    >
                      <option value="">Seleccionar cuenta</option>
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      label="Debe"
                      type="number"
                      min="0"
                      max="100000000"
                      step="0.01"
                      value={l.debit || ''}
                      onChange={(e) => update(i, 'debit', e.target.value)}
                    />
                    <Input
                      label="Haber"
                      type="number"
                      min="0"
                      max="100000000"
                      step="0.01"
                      value={l.credit || ''}
                      onChange={(e) => update(i, 'credit', e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={lines.length <= 2}
                      aria-label={`Quitar renglón ${i + 1}`}
                      onClick={() =>
                        setLines((old) => old.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={lines.length >= 100}
                onClick={() =>
                  setLines((old) => [
                    ...old,
                    { account: '', debit: 0, credit: 0 },
                  ])
                }
              >
                <Plus size={16} />
                Agregar renglón
              </Button>
            </>
          )}
          <div className="journal-totals">
            <span>
              Debe <strong>{formatCurrency(debit, currency)}</strong>
            </span>
            <span>
              Haber <strong>{formatCurrency(credit, currency)}</strong>
            </span>
            <span>
              Diferencia{' '}
              <strong>
                {formatCurrency(
                  Math.round((debit - credit) * 100) / 100,
                  currency,
                )}
              </strong>
            </span>
          </div>
          {currency === 'USD' &&
            Number.isFinite(exchangeRate) &&
            exchangeRate > 0 && (
              <p
                className={
                  debitNio !== creditNio ? 'inline-error' : 'accounting-note'
                }
                role="status"
              >
                Debe C$: {formatCurrency(debitNio, 'NIO')} · Haber C$:{' '}
                {formatCurrency(creditNio, 'NIO')}.
                {roundingNio !== 0
                  ? ` Ajuste de redondeo al banco: ${formatCurrency(roundingNio, 'NIO')}.`
                  : ''}
              </p>
            )}
        </fieldset>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (pending)
                setError(
                  'Verifica primero el guardado pendiente con «Verificar guardado» para evitar duplicar el comprobante.',
                )
              else onClose()
            }}
          >
            Cancelar
          </Button>
          <Button disabled={busy}>
            {busy
              ? 'Guardando…'
              : pending
                ? 'Verificar guardado'
                : 'Guardar comprobante'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function AccountEditor({
  data,
  onSaved,
}: {
  data: LedgerReport
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await journalRpc('save_ledger_account', {
        p_input: { code, name, parent },
      })
      setOpen(false)
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true)
          setError('')
        }}
      >
        Agregar / renombrar cuenta
      </Button>
      {open && (
        <Dialog
          open
          title="Cuenta contable"
          onClose={() => {
            if (!busy) setOpen(false)
          }}
        >
          <form className="day-form" onSubmit={save}>
            <Input
              label="Código"
              required
              pattern="[1-6][0-9]{3}(-[0-9]{3}){0,3}"
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                const a = data.accounts.find((a) => a.code === e.target.value)
                if (a) {
                  setName(a.name)
                  setParent(a.parent ?? '')
                }
              }}
            />
            <Input
              label="Nombre de la cuenta"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Select
              label="Cuenta mayor"
              required={!data.accounts.some((a) => a.code === code)}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">Seleccionar</option>
              {data.accounts
                .filter((a) => !a.postable)
                .map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
            </Select>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <Button disabled={busy}>Guardar cuenta</Button>
          </form>
        </Dialog>
      )}
    </>
  )
}
