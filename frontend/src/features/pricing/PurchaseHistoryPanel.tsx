import { useCallback, useState, type FormEvent } from 'react'
import { History } from 'lucide-react'
import {
  Button,
  Dialog,
  ErrorState,
  Input,
  Select,
  LoadingState,
} from '../../components/ui'
import { useCanVoid } from '../accounting/financeAccess'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { PurchaseDialog } from './CostPanel'
import {
  correctPurchase,
  purchaseBankName,
  purchaseConfirmation,
  type PurchasePaymentTreatment,
  readPurchases,
  type PurchaseCorrectionInput,
  type PurchaseHistoryRecord,
} from './purchaseService'
import './purchase-history.css'

export function PurchaseHistoryPanel({ onChanged }: { onChanged: () => void }) {
  const { role, demo } = useAccess()
  const [open, setOpen] = useState(false)
  if (demo || !can(role, 'product.edit_cost')) return null
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <History size={18} />
        Compras
      </Button>
      {open && (
        <PurchaseHistory onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  )
}

function PurchaseHistory({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const canVoid = useCanVoid()
  const { inventoryService, productService, settingsService } = useServices()
  const [cursor, setCursor] = useState<PurchaseHistoryRecord>()
  const [previous, setPrevious] = useState<
    (PurchaseHistoryRecord | undefined)[]
  >([])
  const load = useCallback(async () => {
    const [rows, inventory, pricing, rate] = await Promise.all([
      readPurchases(cursor),
      inventoryService.getInventory(true),
      productService.listPricing(),
      settingsService.getExchangeRate(),
    ])
    return {
      rows,
      inventory,
      pricing: pricing.rows,
      rate: rate?.usdToNio ?? null,
    }
  }, [cursor, inventoryService, productService, settingsService])
  const { data, loading, error, retry } = useQuery(load)
  const [selected, setSelected] = useState<PurchaseHistoryRecord>()
  const [action, setAction] = useState<'new' | 'replace' | 'cancel'>()
  const [message, setMessage] = useState('')
  const saved = (text: string) => {
    setAction(undefined)
    setSelected(undefined)
    setMessage(text)
    retry()
    onChanged()
  }
  if (action === 'new' && data)
    return (
      <PurchaseDialog
        inventory={data.inventory}
        pricing={data.pricing}
        catalogRate={data.rate}
        initialProduct=""
        onClose={() => setAction(undefined)}
        onRecorded={saved}
      />
    )
  if (action === 'replace' && selected && data)
    return (
      <PurchaseDialog
        inventory={data.inventory}
        pricing={data.pricing}
        catalogRate={data.rate}
        initialProduct={selected.lines[0]?.product_id ?? ''}
        correcting={selected}
        onClose={() => setAction(undefined)}
        onRecorded={saved}
      />
    )
  if (action === 'cancel' && selected)
    return (
      <CancelPurchase
        purchase={selected}
        onClose={() => setAction(undefined)}
        onRecorded={saved}
      />
    )
  return (
    <Dialog
      open
      title="Historial de compras"
      className="purchase-history-dialog"
      onClose={onClose}
    >
      <Button disabled={!data || loading} onClick={() => setAction('new')}>
        Registrar compra
      </Button>
      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <>
          {!data?.rows.length && <p>No hay compras registradas.</p>}
          <div className="purchase-history-list">
            {data?.rows.slice(0, 50).map((row) => (
              <article key={row.id} className="purchase-history-row">
                <div>
                  {row.correction && (
                    <span className="purchase-history-status">Anulada</span>
                  )}
                  <strong>
                    {row.reference || `Compra ${row.id.slice(0, 8)}`}
                  </strong>
                  <p>
                    {row.supplier || 'Proveedor sin nombre'} ·{' '}
                    {formatDate(row.incurred_on)} · {row.units} unidades
                  </p>
                </div>
                <div>
                  <strong>
                    {formatCurrency(
                      Number(row.goods_amount) + Number(row.shipping_amount),
                      row.currency,
                    )}
                  </strong>
                  <p>
                    {row.account === 'banco'
                      ? purchaseBankName(row.bank_ledger_account)
                      : row.account === 'credito'
                        ? 'Crédito del proveedor'
                        : 'Caja'}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setSelected(selected?.id === row.id ? undefined : row)
                  }
                >
                  {selected?.id === row.id ? 'Ocultar detalle' : 'Ver compra'}
                </Button>
                {selected?.id === row.id && (
                  <div className="purchase-history-detail">
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Perfume</th>
                            <th>Ubicación</th>
                            <th>Unidades</th>
                            <th>Costo unitario</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.lines.map((line) => (
                            <tr key={line.product_id}>
                              <td>
                                {line.product_sku} · {line.product_name}
                              </td>
                              <td>
                                {line.location === 'store'
                                  ? 'Tienda'
                                  : 'Bodega'}
                              </td>
                              <td>{line.quantity}</td>
                              <td>
                                {formatCurrency(
                                  Number(line.unit_price),
                                  row.currency,
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p>
                      Envío:{' '}
                      {formatCurrency(
                        Number(row.shipping_amount),
                        row.currency,
                      )}
                      {row.note ? ` · ${row.note}` : ''}
                    </p>
                    {row.correction ? (
                      <div className="purchase-correction-record">
                        <strong>
                          Compra anulada el{' '}
                          {formatDate(row.correction.occurred_on)}
                        </strong>
                        <p>
                          {row.correction.reason} · {row.correction.actor_name}
                        </p>
                        <p>
                          {row.correction.payment_treatment === 'keep_payments'
                            ? 'Abonos conservados'
                            : row.correction.payment_treatment ===
                                'recording_error'
                              ? 'Pagos corregidos'
                              : 'Pagos devueltos'}
                          :{' '}
                          {formatCurrency(
                            Number(
                              row.correction.payment_treatment ===
                                'keep_payments'
                                ? row.correction.reallocated_nio
                                : row.correction.refunded_nio,
                            ),
                            'NIO',
                          )}
                        </p>
                        {row.correction.replacement_id && (
                          <p>
                            Reemplazo:{' '}
                            {row.correction.replacement_id.slice(0, 8)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <>
                        {row.correction_problem ? (
                          <p role="note">{row.correction_problem}</p>
                        ) : canVoid ? (
                          <div className="form-actions">
                            <Button
                              variant="secondary"
                              onClick={() => setAction('replace')}
                            >
                              Corregir compra
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => setAction('cancel')}
                            >
                              Anular compra
                            </Button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
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
                setSelected(undefined)
              }}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              disabled={!data || data.rows.length <= 50}
              onClick={() => {
                setPrevious([...previous, cursor])
                setCursor(data?.rows[49])
                setSelected(undefined)
              }}
            >
              Siguiente
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

function CancelPurchase({
  purchase,
  onClose,
  onRecorded,
}: {
  purchase: PurchaseHistoryRecord
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<PurchaseCorrectionInput, 'requestId'>,
      unknown
    >(correctPurchase, {
      scope: storageScope,
      key: 'purchase-correction',
      label: 'Anulación de compra',
    }),
  )
  const [reason, setReason] = useState('')
  const [refund, setRefund] = useState(false)
  const [paymentTreatment, setPaymentTreatment] =
    useState<PurchasePaymentTreatment>('recording_error')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const uncertain = operation.isUncertain()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (
      !uncertain &&
      (reason.trim().length < 3 || (purchase.refund_nio > 0 && !refund))
    ) {
      setFailure('Escribe el motivo y confirma cómo se corregirán los pagos.')
      return
    }
    setBusy(true)
    setFailure('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          shipmentId: purchase.id,
          reason: reason.trim(),
          refundConfirmed: refund,
          paymentTreatment,
        })
      onRecorded(
        'Compra anulada. El original y la corrección permanecen en el historial.',
      )
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Anular compra"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || uncertain}>
          <p>
            {purchase.reference || `Compra ${purchase.id.slice(0, 8)}`} ·{' '}
            {purchase.supplier}. Se retirarán sus {purchase.units} unidades y se
            recuperará el costo anterior. La anulación queda en la jornada de
            hoy.
          </p>
          <Input
            label="Motivo de la anulación"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {purchase.refund_nio > 0 && (
            <Select
              label="Tratamiento de los pagos"
              value={paymentTreatment}
              onChange={(event) => {
                setPaymentTreatment(
                  event.target.value as PurchasePaymentTreatment,
                )
                setRefund(false)
              }}
            >
              <option value="recording_error">
                Corregir pagos registrados por error
              </option>
              <option value="refund">
                Registrar devolución real del proveedor
              </option>
            </Select>
          )}
          {purchase.refund_nio > 0 && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={refund}
                onChange={(event) => setRefund(event.target.checked)}
              />
              {purchaseConfirmation(paymentTreatment)} (
              {formatCurrency(Number(purchase.refund_nio), 'NIO')}).
            </label>
          )}
        </fieldset>
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Guardando…'
              : uncertain
                ? 'Verificar guardado'
                : 'Confirmar anulación'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || uncertain}
            onClick={onClose}
          >
            Cancelar
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
