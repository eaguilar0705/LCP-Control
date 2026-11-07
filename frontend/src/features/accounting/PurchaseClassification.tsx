import { useCallback, useState } from 'react'
import {
  Button,
  Card,
  Dialog,
  ErrorState,
  LoadingState,
  Select,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { formatCurrency, formatDate } from '../../lib/format'
import { journalRpc } from './journalService'
import { MultiCurrencyJournal } from './MultiCurrencyJournal'
import type { JournalDetailRecord, LedgerReport } from './journalModel'
import { errorMessage } from '../../lib/errors'
import { localDay } from '../reports/model'
import { ReceiptEditor } from '../pricing/ReceiptEditor'

interface Receipt {
  id: string
  incurred_on: string
  supplier: string
  reference: string
  currency: 'NIO' | 'USD'
  exchange_rate: number
  goods_amount: number
  shipping_amount: number
  units: number
  created_at: string
  entry_id: string | null
  classified: boolean
  revision: number | null
  payments: {
    id: string
    occurredOn: string
    amount: number
    currency: 'NIO' | 'USD'
    reference: string
  }[]
  linked_payments: string[]
}

export function PurchaseClassification({
  data,
  onChanged,
}: {
  data: LedgerReport
  onChanged: () => void
}) {
  const { role } = useAccess()
  const [status, setStatus] = useState('pending')
  const [cursor, setCursor] = useState<Receipt>()
  const [previous, setPrevious] = useState<(Receipt | undefined)[]>([])
  const load = useCallback(
    () =>
      journalRpc<Receipt[]>('purchase_accounting_rows', {
        p_status: status,
        p_before: cursor?.created_at ?? null,
        p_before_id: cursor?.id ?? null,
      }),
    [status, cursor],
  )
  const query = useQuery(load)
  const [receipt, setReceipt] = useState<Receipt>()
  const [editingReceipt, setEditingReceipt] = useState<string>()
  return (
    <Card className="accounting-card purchase-classification">
      <div className="section-heading">
        <h2>Recepciones de inventario</h2>
        <Select
          label="Mostrar recepciones"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setCursor(undefined)
            setPrevious([])
          }}
        >
          <option value="pending">Pendientes de clasificar</option>
          <option value="all">Todas</option>
        </Select>
      </div>
      {query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : query.loading ? (
        <LoadingState />
      ) : (
        <>
          {!query.data?.length && (
            <p>
              {status === 'pending'
                ? 'No hay recepciones pendientes.'
                : 'No hay recepciones registradas.'}
            </p>
          )}
          <div className="classification-receipts">
            {query.data?.map((r) => (
              <article key={r.id}>
                <div>
                  <strong>{r.reference || 'Recepción de mercancía'}</strong>
                  <p>
                    {r.supplier || 'Proveedor por indicar'} ·{' '}
                    {formatDate(r.incurred_on)} · {r.units} unidades
                  </p>
                </div>
                <div>
                  <strong>
                    {formatCurrency(
                      Number(r.goods_amount) + Number(r.shipping_amount),
                      r.currency,
                    )}
                  </strong>
                  <p>
                    {r.classified ? 'Clasificada' : 'Pendiente de clasificar'}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setReceipt(r)}>
                  {r.classified
                    ? role === 'superadmin'
                      ? 'Editar clasificación'
                      : 'Ver clasificación'
                    : 'Clasificar compra'}
                </Button>
                {role === 'superadmin' && (
                  <Button
                    variant="ghost"
                    onClick={() => setEditingReceipt(r.id)}
                  >
                    Editar recepción
                  </Button>
                )}
              </article>
            ))}
          </div>
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={!previous.length}
              onClick={() => {
                setCursor(previous.at(-1))
                setPrevious(previous.slice(0, -1))
              }}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              disabled={query.data?.length !== 50}
              onClick={() => {
                setPrevious([...previous, cursor])
                setCursor(query.data?.at(-1))
              }}
            >
              Siguiente
            </Button>
            <Button variant="ghost" onClick={query.retry}>
              Actualizar recepciones
            </Button>
          </div>
        </>
      )}
      {editingReceipt && (
        <ReceiptEditor
          id={editingReceipt}
          onClose={() => setEditingReceipt(undefined)}
          onSaved={() => {
            setEditingReceipt(undefined)
            query.retry()
            onChanged()
          }}
        />
      )}
      {receipt && (
        <ClassificationDialog
          receipt={receipt}
          data={data}
          onClose={() => setReceipt(undefined)}
          onSaved={() => {
            setReceipt(undefined)
            query.retry()
            onChanged()
          }}
        />
      )}
    </Card>
  )
}

function ClassificationDialog({
  receipt,
  data,
  onClose,
  onSaved,
}: {
  receipt: Receipt
  data: LedgerReport
  onClose: () => void
  onSaved: () => void
}) {
  const load = useCallback(
    () =>
      receipt.entry_id
        ? journalRpc<JournalDetailRecord>('get_journal_entry', {
            p_id: receipt.entry_id,
          })
        : Promise.resolve(null),
    [receipt.entry_id],
  )
  const query = useQuery(load)
  const { role } = useAccess()
  const [linked, setLinked] = useState<string[]>(receipt.linked_payments)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const [confirmPending, setConfirmPending] = useState(false)
  const total =
    Math.round(
      Number(receipt.goods_amount) * Number(receipt.exchange_rate) * 100,
    ) /
      100 +
    Math.round(
      Number(receipt.shipping_amount) * Number(receipt.exchange_rate) * 100,
    ) /
      100
  return (
    <Dialog
      open
      title={
        receipt.classified
          ? 'Editar clasificación de compra'
          : 'Clasificar compra'
      }
      className="journal-dialog"
      dismissible={!pending}
      onClose={() => {
        if (!pending) onClose()
      }}
    >
      <p>
        {receipt.reference} · {receipt.supplier} · Recibido el{' '}
        {formatDate(receipt.incurred_on)}
      </p>
      {query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : query.loading ? (
        <LoadingState />
      ) : receipt.classified && role !== 'superadmin' ? (
        <p>
          Comprobante registrado. El SuperAdmin puede corregir la clasificación.
        </p>
      ) : (
        <MultiCurrencyJournal
          entry={query.data && !query.data.voided_at ? query.data : undefined}
          accounts={
            query.data?.editingAccounts ??
            data.accounts.filter(
              (a) => a.postable && a.active !== false && a.code !== '2190',
            )
          }
          kind="adjustment"
          initialDescription={`Clasificación de compra${receipt.reference ? ': ' + receipt.reference : ''}`}
          initialReference={receipt.reference}
          initialDate={localDay(new Date())}
          initialLines={[
            {
              account: '1130',
              currency: 'NIO',
              exchangeRate: 1,
              debit: total,
              credit: 0,
            },
            {
              account: '',
              currency: 'NIO',
              exchangeRate: 1,
              debit: 0,
              credit: total,
            },
          ]}
          fixedInventoryDebit={total}
          submitName="classify_purchase"
          extraInput={{
            shipmentId: receipt.id,
            linkedPayments: linked,
            ...(receipt.entry_id ? { entryId: receipt.entry_id } : {}),
          }}
          onPending={setPending}
          onSaved={onSaved}
          onCancel={onClose}
        >
          {!!receipt.payments.length && (
            <details className="day-history">
              <summary>Vincular pagos ya registrados</summary>
              {receipt.payments.map((p) => (
                <label key={p.id} className="classification-payment">
                  <input
                    type="checkbox"
                    checked={linked.includes(p.id)}
                    onChange={(e) =>
                      setLinked((old) =>
                        e.target.checked
                          ? [...old, p.id]
                          : old.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span>
                    {formatDate(p.occurredOn)} ·{' '}
                    {formatCurrency(p.amount, p.currency)} ·{' '}
                    {p.reference || 'Pago a proveedor'}
                  </span>
                </label>
              ))}
              <p>
                Incluye esos pagos en Proveedores; ya descontaron Caja o Banco.
              </p>
            </details>
          )}
        </MultiCurrencyJournal>
      )}
      {failure && (
        <p role="alert" className="inline-error">
          {failure}
        </p>
      )}
      {receipt.classified && role === 'superadmin' && (
        <div className="form-actions">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              if (!confirmPending) {
                setConfirmPending(true)
                return
              }
              setPending(true)
              setFailure('')
              try {
                await journalRpc('void_journal_entry', {
                  p_id: receipt.entry_id,
                  p_reason: 'Clasificación devuelta a pendiente por SuperAdmin',
                })
                onSaved()
              } catch (e) {
                setFailure(errorMessage(e))
              } finally {
                setPending(false)
              }
            }}
          >
            {confirmPending
              ? 'Confirmar: dejar pendiente'
              : 'Dejar pendiente de clasificar'}
          </Button>
        </div>
      )}
    </Dialog>
  )
}
