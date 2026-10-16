import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Card, Dialog, Input, Select } from '../../components/ui'
import { errorMessage } from '../../lib/errors'
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
import { journalRpc } from './journalService'
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
  const [action, setAction] = useState<Kind | null>(null)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const entries = [...data.entries, ...(data.automaticEntries ?? [])].sort(
    (a, b) =>
      b.occurred_on.localeCompare(a.occurred_on) ||
      b.number - a.number ||
      a.id.localeCompare(b.id),
  )
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
      <div className="accounting-table-scroll">
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
            {entries.slice(0, 500).map((e) => (
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
                  ) : (
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
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length === 0 && <p>Sin comprobantes en este período.</p>}
      {entries.length > 500 && (
        <p role="status">
          Se muestran 500 comprobantes. Reduce el período para consultar los
          restantes.
        </p>
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
          entry={data.automaticEntries?.find((e) => e.id === detailId)}
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
  const [date, setDate] = useState(localDay(new Date()))
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [currency, setCurrency] = useState<'NIO' | 'USD'>('NIO')
  const [rate, setRate] = useState('')
  const [lines, setLines] = useState<Line[]>([
    { account: '', debit: 0, credit: 0 },
    { account: '', debit: 0, credit: 0 },
  ])
  const [amount, setAmount] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [commission, setCommission] = useState('')
  const [withholding, setWithholding] = useState('')
  const [withholdingBase, setWithholdingBase] = useState<
    'gross' | 'net_commission'
  >('gross')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{
    key: string
    requestId: string
  } | null>(null)
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
  } catch {
    /* Inputs remain invalid until completed. */
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
    valid: balanced,
  } = journalTotals(activeLines, exchangeRate)
  const valid =
    balanced &&
    activeLines.every((l) => accounts.some((a) => a.code === l.account)) &&
    (!simple || activeLines[0].account !== activeLines.at(-1)?.account)
  function update(index: number, key: keyof Line, value: string) {
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
    if (busy || !valid) return
    setBusy(true)
    setError('')
    const payload = {
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
    const key = JSON.stringify(payload),
      requestId = attempt?.key === key ? attempt.requestId : crypto.randomUUID()
    setAttempt({ key, requestId })
    try {
      await journalRpc('record_journal_entry', {
        p_input: { ...payload, requestId },
      })
      onSaved()
    } catch (e) {
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
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form className="day-form" onSubmit={save}>
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
                    <option value="net_commission">Venta menos comisión</option>
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
                    Neto a acreditar: {formatCurrency(settlement.net, currency)}
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
              {formatCurrency(creditNio, 'NIO')}. Cada renglón se convierte por
              separado; ambos totales deben coincidir también en córdobas.
            </p>
          )}
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
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button disabled={busy || !valid}>
            {busy ? 'Guardando…' : 'Guardar comprobante'}
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
