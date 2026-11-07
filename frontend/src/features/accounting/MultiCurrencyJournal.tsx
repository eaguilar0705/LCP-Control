import { useState, type FormEvent, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Select } from '../../components/ui'
import { formatCurrency } from '../../lib/format'
import { localDay } from '../reports/model'
import { useAccess } from '../../app/AccessContext'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { journalRpc } from './journalService'
import {
  accountCurrency,
  mixedJournalTotals,
  type JournalDetailRecord,
  type JournalLine,
} from './journalModel'

type Account = {
  code: string
  displayCode?: string
  name: string
  bucket: string
}
export interface AccountingDraft {
  id: string
  revision: number
  data: {
    date: string
    description: string
    reference: string
    lines: JournalLine[]
    kind: string
    submitName?: string
    extraInput?: Record<string, unknown>
    entryId?: string
    expectedRevision?: number
    fixedInventoryDebit?: number
  }
}
const blank = (): JournalLine => ({
  account: '',
  currency: 'NIO',
  exchangeRate: 1,
  debit: 0,
  credit: 0,
})

export function MultiCurrencyJournal({
  entry,
  accounts,
  kind = 'adjustment',
  initialLines,
  initialReference = '',
  initialDescription = '',
  initialDate,
  submitName,
  extraInput,
  initialDraft,
  fixedInventoryDebit,
  children,
  onSaved,
  onCancel,
  onPending,
}: {
  entry?: JournalDetailRecord
  accounts: Account[]
  kind?: string
  initialLines?: JournalLine[]
  initialReference?: string
  initialDescription?: string
  initialDate?: string
  submitName?: string
  initialDraft?: AccountingDraft
  fixedInventoryDebit?: number
  extraInput?: Record<string, unknown>
  children?: ReactNode
  onSaved: () => void
  onCancel: () => void
  onPending?: (value: boolean) => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const purchaseClassification =
    submitName === 'classify_purchase' ||
    initialDraft?.data.submitName === 'classify_purchase' ||
    Boolean(entry?.sourceReceiptId && !entry.receiptCorrection)
  const selectableAccounts = accounts.filter(
    (account) =>
      account.code !== '2190' &&
      (!purchaseClassification || account.code !== '1130'),
  )
  const [date, setDate] = useState(
    initialDraft?.data.date ??
      entry?.occurred_on ??
      initialDate ??
      localDay(new Date()),
  )
  const [description, setDescription] = useState(
    initialDraft?.data.description ?? entry?.description ?? initialDescription,
  )
  const [reference, setReference] = useState(
    initialDraft?.data.reference ?? entry?.reference ?? initialReference,
  )
  const [lines, setLines] = useState<JournalLine[]>(() => {
    const entryLines = entry?.lines.map((l) => ({
      account: l.account,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
      currency: l.currency ?? entry.currency,
      exchangeRate: l.exchange_rate ?? entry.exchange_rate,
    }))
    const source = initialDraft?.data.lines ??
      entryLines ??
      initialLines ?? [blank(), blank()]
    if (!purchaseClassification) return source
    const inventoryAccounts = (line: JournalLine) =>
      line.account === '1130' || line.account === '2190'
    const inventoryTotals = mixedJournalTotals(
      (entryLines ?? source).filter(inventoryAccounts),
    )
    const debit =
      fixedInventoryDebit ??
      entry?.purchaseInventoryDebit ??
      (entryLines
        ? inventoryTotals.debitNio - inventoryTotals.creditNio
        : (initialDraft?.data.fixedInventoryDebit ??
          inventoryTotals.debitNio - inventoryTotals.creditNio))
    const counterparts = source.filter((line) => !inventoryAccounts(line))
    return [
      { account: '1130', currency: 'NIO', exchangeRate: 1, debit, credit: 0 },
      ...(counterparts.length ? counterparts : [blank()]),
    ]
  })
  const [draftId] = useState(() => initialDraft?.id ?? crypto.randomUUID())
  const [draftRevision, setDraftRevision] = useState(
    initialDraft?.revision ?? -1,
  )
  const [notice, setNotice] = useState('')
  const [draftOperation] = useState(() =>
    createIdempotentOperation<Record<string, unknown>, AccountingDraft>(
      (input) => journalRpc('save_accounting_draft', { p_input: input }),
      {
        scope: storageScope,
        key: 'accounting-draft',
        label: 'Borrador contable',
      },
    ),
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const [operation] = useState(() =>
    createIdempotentOperation<Record<string, unknown>, unknown>(
      (input) =>
        journalRpc(
          submitName ??
            (entry ? 'correct_journal_entry' : 'record_journal_entry'),
          { p_input: input },
        ),
      {
        scope: storageScope,
        key:
          submitName === 'classify_purchase'
            ? 'purchase-classification'
            : entry
              ? 'journal-correction'
              : 'journal',
        label: entry ? 'Edición de comprobante' : 'Comprobante',
      },
    ),
  )
  const totals = mixedJournalTotals(lines)
  const uncertain = operation.isUncertain()
  function update(index: number, patch: Partial<JournalLine>) {
    if (purchaseClassification && index === 0) return
    setError('')
    setReview(false)
    setLines((old) => old.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!uncertain && !totals.valid) {
      setError(
        'Revisa las cuentas, monedas y tipos de cambio. El Debe y el Haber deben coincidir en córdobas.',
      )
      return
    }
    if (!uncertain && !review) {
      setReview(true)
      return
    }
    setBusy(true)
    setError('')
    onPending?.(true)
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          occurredOn: date,
          description: description.trim(),
          reference,
          kind: entry?.kind ?? kind,
          currency: 'NIO',
          exchangeRate: 1,
          lines,
          ...(entry
            ? {
                entryId: entry.id,
                expectedRevision:
                  initialDraft?.data.expectedRevision ?? entry.revision ?? 0,
              }
            : {}),
          ...extraInput,
          ...(draftRevision >= 0 ? { draftId, draftRevision } : {}),
        })
      onPending?.(false)
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
      onPending?.(operation.isUncertain())
    } finally {
      setBusy(false)
    }
  }
  async function saveDraft() {
    if (busy) return
    setBusy(true)
    setError('')
    onPending?.(true)
    try {
      const saved = draftOperation.isUncertain()
        ? await draftOperation.retryPending()
        : await draftOperation.execute({
            draftId,
            expectedRevision: draftRevision,
            data: {
              date,
              description,
              reference,
              lines,
              kind: entry?.kind ?? kind,
              submitName,
              extraInput,
              ...(purchaseClassification
                ? { fixedInventoryDebit: lines[0].debit }
                : {}),
              ...(entry
                ? {
                    entryId: entry.id,
                    expectedRevision:
                      initialDraft?.data.expectedRevision ??
                      entry.revision ??
                      0,
                  }
                : {}),
            },
          })
      setDraftRevision(saved.revision)
      setNotice('Borrador guardado.')
      onPending?.(false)
    } catch (e) {
      setError(errorMessage(e))
      onPending?.(draftOperation.isUncertain())
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="mixed-journal-form"
      onChange={() => setReview(false)}
      onSubmit={(event) => void save(event)}
    >
      <fieldset disabled={busy || uncertain || draftOperation.isUncertain()}>
        <div className="journal-fields">
          <Input
            label="Fecha"
            type="date"
            required
            max={localDay(new Date())}
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              setReview(false)
            }}
          />
          <Input
            label="Referencia"
            maxLength={200}
            value={reference}
            onChange={(e) => {
              setReference(e.target.value)
              setReview(false)
            }}
          />
        </div>
        <Input
          label="Concepto"
          required
          maxLength={300}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
            setReview(false)
          }}
        />
        {children}
        {purchaseClassification && (
          <p className="accounting-note">
            El total recibido se carga a Inventario de perfumes. Elige las
            cuentas con las que pagaste o Proveedores si quedó a crédito. Para
            cambiar unidades o costos, edita la recepción.
          </p>
        )}
        <div className="mixed-journal-lines">
          {lines.map((line, i) => (
            <div className="mixed-journal-line" key={i}>
              <Select
                label={`Cuenta ${i + 1}`}
                required
                value={line.account}
                disabled={purchaseClassification && i === 0}
                onChange={(e) => {
                  const currency =
                    accountCurrency(e.target.value) ?? line.currency ?? 'NIO'
                  update(i, {
                    account: e.target.value,
                    currency,
                    exchangeRate:
                      currency === 'NIO'
                        ? 1
                        : line.currency === 'USD'
                          ? line.exchangeRate
                          : undefined,
                  })
                }}
              >
                <option value="">Seleccionar cuenta</option>
                {purchaseClassification && i === 0 && (
                  <option value="1130">
                    {accounts.find((a) => a.code === '1130')?.displayCode ??
                      '1130'}{' '}
                    · Inventario de perfumes
                  </option>
                )}
                {selectableAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.displayCode ?? a.code} · {a.name}
                  </option>
                ))}
              </Select>
              <Select
                label={`Moneda ${i + 1}`}
                value={line.currency ?? 'NIO'}
                disabled={
                  (purchaseClassification && i === 0) ||
                  accountCurrency(line.account) !== null
                }
                onChange={(e) =>
                  update(i, {
                    currency: e.target.value as 'NIO' | 'USD',
                    exchangeRate: e.target.value === 'NIO' ? 1 : undefined,
                  })
                }
              >
                <option value="NIO">C$</option>
                <option value="USD">US$</option>
              </Select>
              {line.currency === 'USD' ? (
                <Input
                  label={`Tipo de cambio ${i + 1}`}
                  type="number"
                  required
                  min="0.000001"
                  max="1000"
                  step="0.000001"
                  value={line.exchangeRate ?? ''}
                  readOnly={purchaseClassification && i === 0}
                  onChange={(e) =>
                    update(i, { exchangeRate: Number(e.target.value) })
                  }
                />
              ) : (
                <div className="mixed-rate">Córdobas · tasa 1</div>
              )}
              <Input
                label={`Debe ${i + 1}`}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={line.debit || ''}
                readOnly={purchaseClassification && i === 0}
                onChange={(e) =>
                  update(i, {
                    debit: Number(e.target.value),
                    ...(Number(e.target.value) > 0 ? { credit: 0 } : {}),
                  })
                }
              />
              <Input
                label={`Haber ${i + 1}`}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={line.credit || ''}
                readOnly={purchaseClassification && i === 0}
                onChange={(e) =>
                  update(i, {
                    credit: Number(e.target.value),
                    ...(Number(e.target.value) > 0 ? { debit: 0 } : {}),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                disabled={
                  lines.length <= 2 || (purchaseClassification && i === 0)
                }
                aria-label={`Quitar renglón ${i + 1}`}
                onClick={() => {
                  if (purchaseClassification && i === 0) return
                  setLines((old) => old.filter((_, j) => j !== i))
                  setReview(false)
                }}
              >
                <Trash2 size={16} />
              </Button>
              <span className="mixed-equivalent">
                Equivale a{' '}
                {formatCurrency(
                  (line.debit || line.credit) *
                    (line.currency === 'USD' ? (line.exchangeRate ?? 0) : 1),
                  'NIO',
                )}
              </span>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={lines.length >= 100}
          onClick={() => {
            setLines((old) => [...old, blank()])
            setReview(false)
          }}
        >
          <Plus size={16} />
          Agregar cuenta
        </Button>
      </fieldset>
      <div className="journal-totals">
        <span>
          Debe C${' '}
          <strong>
            {Number.isFinite(totals.debitNio)
              ? formatCurrency(totals.debitNio, 'NIO')
              : '—'}
          </strong>
        </span>
        <span>
          Haber C${' '}
          <strong>
            {Number.isFinite(totals.creditNio)
              ? formatCurrency(totals.creditNio, 'NIO')
              : '—'}
          </strong>
        </span>
        <span>
          Diferencia{' '}
          <strong>
            {Number.isFinite(totals.difference)
              ? formatCurrency(totals.difference, 'NIO')
              : '—'}
          </strong>
        </span>
      </div>
      {review && (
        <p role="status" className="accounting-note">
          Revisa la fecha, las cuentas y los importes antes de confirmar.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" disabled={busy || draftOperation.isUncertain()}>
          {busy
            ? 'Guardando…'
            : uncertain
              ? 'Verificar guardado'
              : review
                ? 'Confirmar comprobante'
                : 'Revisar y guardar'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || uncertain}
          onClick={() => void saveDraft()}
        >
          {draftOperation.isUncertain()
            ? 'Verificar borrador'
            : 'Guardar borrador'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || uncertain || draftOperation.isUncertain()}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </form>
  )
}
