import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Select } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { AppError, errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import {
  forgetOperationReference,
  getOperationReferences,
  rememberOperationReference,
} from '../../lib/operationRecovery'
import {
  journalTotals,
  type JournalDetailRecord,
  type JournalLine,
} from './journalModel'
import { journalRpc } from './journalService'

export function OpeningJournalEditor({
  entry,
  onCancel,
  onSaved,
  onPending,
}: {
  entry: JournalDetailRecord
  onCancel: () => void
  onSaved: () => void
  onPending: (value: boolean) => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const [description, setDescription] = useState(entry.description)
  const [reference, setReference] = useState(entry.reference)
  const [lines, setLines] = useState<JournalLine[]>(() =>
    entry.lines.map((l) => ({
      account: l.account,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Record<string, unknown> | null>(null)
  const [stale, setStale] = useState(false)
  const accounts = entry.openingAccounts ?? []
  const totals = journalTotals(lines, entry.exchange_rate)
  const original = entry.lines.map((l) => ({
    account: l.account,
    debit: l.debit ?? 0,
    credit: l.credit ?? 0,
  }))
  const changed =
    description.trim() !== entry.description ||
    reference !== entry.reference ||
    JSON.stringify(lines) !== JSON.stringify(original)
  const equityLines = lines
    .map((l, i) => ({ ...l, i }))
    .filter(
      (l) => accounts.find((a) => a.code === l.account)?.bucket === 'equity',
    )
  function update(index: number, key: keyof JournalLine, value: string) {
    setError('')
    setLines((old) =>
      old.map((l, i) =>
        i === index
          ? { ...l, [key]: key === 'account' ? value : Number(value) }
          : l,
      ),
    )
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || stale) return
    if (!pending && !totals.valid) {
      setError('El Debe y el Haber deben sumar lo mismo. Revisa los importes.')
      return
    }
    if (
      getOperationReferences(storageScope).some(
        (r) =>
          r.kind === 'opening-journal-correction' &&
          r.requestId !== pending?.requestId,
      )
    ) {
      setError(
        'Hay una edición anterior por verificar. Consulta su guardado antes de continuar.',
      )
      return
    }
    const payload = pending ?? {
      requestId: crypto.randomUUID(),
      entryId: entry.id,
      expectedRevision: entry.revision ?? 0,
      description: description.trim(),
      reference,
      lines,
    }
    const requestId = String(payload.requestId)
    setBusy(true)
    setError('')
    try {
      rememberOperationReference(
        storageScope,
        'opening-journal-correction',
        requestId,
      )
      setPending(payload)
      onPending(true)
      await journalRpc('correct_opening_journal', { p_input: payload })
      forgetOperationReference(
        storageScope,
        'opening-journal-correction',
        requestId,
      )
      setPending(null)
      onPending(false)
      onSaved()
    } catch (failure) {
      if (
        failure instanceof AppError &&
        (failure.kind === 'validation' ||
          (!pending &&
            ['unauthorized', 'rate_limited', 'configuration'].includes(
              failure.kind,
            )))
      ) {
        forgetOperationReference(
          storageScope,
          'opening-journal-correction',
          requestId,
        )
        setPending(null)
        onPending(false)
        if (/apertura cambió/.test(failure.message)) setStale(true)
      }
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="day-form"
      onSubmit={save}
      onChange={() => {
        if (!pending && !stale) setError('')
      }}
    >
      <p>
        <strong>{formatDate(entry.occurred_on)}</strong> · Importes en{' '}
        {entry.currency}
        {entry.currency === 'USD'
          ? ` · Tipo de cambio ${entry.exchange_rate}`
          : ''}
      </p>
      <fieldset
        className="journal-entry-fields"
        disabled={busy || !!pending || stale}
      >
        <Input
          label="Concepto"
          required
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          label="Referencia / número de documento"
          maxLength={200}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <div className="journal-lines">
          {lines.map((line, index) => (
            <div className="journal-line" key={index}>
              <Select
                label={`Cuenta ${index + 1}`}
                value={line.account}
                required
                disabled={line.account === '1130'}
                onChange={(e) => update(index, 'account', e.target.value)}
              >
                <option value="">Seleccionar cuenta</option>
                {accounts
                  .filter((a) => a.code !== '1130' || line.account === '1130')
                  .map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.displayCode ?? a.code} · {a.name}
                    </option>
                  ))}
              </Select>
              <Input
                label={`Debe ${index + 1}`}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={line.debit || ''}
                disabled={line.account === '1130'}
                onChange={(e) => update(index, 'debit', e.target.value)}
              />
              <Input
                label={`Haber ${index + 1}`}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={line.credit || ''}
                disabled={line.account === '1130'}
                onChange={(e) => update(index, 'credit', e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                aria-label={`Quitar renglón ${index + 1}`}
                disabled={line.account === '1130' || lines.length <= 2}
                onClick={() =>
                  setLines((old) => old.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </div>
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={lines.length >= 100}
            onClick={() =>
              setLines((old) => [...old, { account: '', debit: 0, credit: 0 }])
            }
          >
            <Plus size={16} />
            Agregar cuenta
          </Button>
          {equityLines.length === 1 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setError('')
                const index = equityLines[0].i
                const difference =
                  Math.round(
                    lines.reduce(
                      (sum, l, i) =>
                        i === index ? sum : sum + l.debit - l.credit,
                      0,
                    ) * 100,
                  ) / 100
                setLines((old) =>
                  old.map((l, i) =>
                    i === index
                      ? {
                          ...l,
                          debit: Math.max(0, -difference),
                          credit: Math.max(0, difference),
                        }
                      : l,
                  ),
                )
              }}
            >
              Cuadrar patrimonio
            </Button>
          )}
        </div>
        {lines.some((l) => l.account === '1130') && (
          <small>
            El inventario se corrige desde Inventario y su conciliación
            contable.
          </small>
        )}
        <div className="journal-totals" aria-live="polite">
          <span>
            Debe <strong>{formatCurrency(totals.debit, entry.currency)}</strong>
          </span>
          <span>
            Haber{' '}
            <strong>{formatCurrency(totals.credit, entry.currency)}</strong>
          </span>
          <span>
            Diferencia{' '}
            <strong>
              {formatCurrency(
                Math.round((totals.debit - totals.credit) * 100) / 100,
                entry.currency,
              )}
            </strong>
          </span>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {stale && (
        <p>
          Vuelve al comprobante y ábrelo de nuevo para cargar la última versión.
        </p>
      )}
      <div className="form-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !!pending}
          onClick={onCancel}
        >
          Cancelar
        </Button>
        <Button disabled={busy || stale || (!pending && !changed)}>
          {busy
            ? 'Guardando…'
            : pending
              ? 'Verificar guardado'
              : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  )
}
