import { useCallback, useState, type FormEvent } from 'react'
import { PackagePlus, RefreshCw } from 'lucide-react'
import {
  Button,
  Card,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { can } from '../../lib/permissions'
import { useQuery } from '../../lib/useQuery'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { inventoryExchangeRate } from '../../lib/exchangeRates'
import { formatCurrency, formatDate } from '../../lib/format'
import { labels, type InventoryItem } from '../../lib/domain'
import { PurchaseDialog } from '../pricing/CostPanel'
import { ReceiptEditor } from '../pricing/ReceiptEditor'
import { journalRpc } from '../accounting/journalService'
import type { LedgerAccount } from '../accounting/journalModel'
import { purchaseBankName } from '../pricing/purchaseService'
import { InventoryReceiptDialog } from './InventoryReceiptDialog'
import {
  cancelInventoryReceipt,
  readInventoryReceipts,
  type InventoryReceiptRecord,
  type ReceiptStatus,
} from './inventoryReceipts'
import type { CancelInventoryReceiptInput } from '@lcp/contracts/inventoryReceipts'
import './inventory-receipts.css'

const statusLabels = {
  pending: 'Pendiente de revisión',
  posted: 'Contabilizada',
  cancelled: 'Cancelada',
}

export function InventoryReceiptsPanel({
  items,
  onChanged,
  allowCreate = false,
  refreshKey = 0,
}: {
  items?: InventoryItem[]
  onChanged: () => void
  allowCreate?: boolean
  refreshKey?: number
}) {
  const { role, demo } = useAccess()
  if (demo || !can(role, 'inventory.create_entry')) return null
  return (
    <ReceiptWorkspace
      items={items ?? []}
      onChanged={onChanged}
      allowCreate={allowCreate}
      refreshKey={refreshKey}
    />
  )
}

function ReceiptWorkspace({
  items,
  onChanged,
  allowCreate,
  refreshKey,
}: {
  items: InventoryItem[]
  onChanged: () => void
  allowCreate: boolean
  refreshKey: number
}) {
  const { role, storageScope } = useAccess()
  const review = can(role, 'product.edit_cost')
  const actorId = storageScope?.startsWith('user:') ? storageScope.slice(5) : ''
  const [status, setStatus] = useState<ReceiptStatus>('pending')
  const [cursor, setCursor] = useState<{ createdAt: string; id: string }>()
  const [previous, setPrevious] = useState<(typeof cursor)[]>([])
  const load = useCallback(() => {
    // Refresh after an Entrada is received by the movement dialog as well.
    void refreshKey
    return readInventoryReceipts(status, cursor)
  }, [status, cursor, refreshKey])
  const { data, loading, error, retry, refresh } = useQuery(load)
  const [creating, setCreating] = useState(false)
  const [editingShipmentId, setEditingShipmentId] = useState<string>()
  const [selected, setSelected] = useState<InventoryReceiptRecord>()
  const [cancelling, setCancelling] = useState<InventoryReceiptRecord>()
  const [message, setMessage] = useState('')
  function saved(text: string) {
    if (creating) {
      setStatus('pending')
      setCursor(undefined)
      setPrevious([])
    }
    setCreating(false)
    setEditingShipmentId(undefined)
    setSelected(undefined)
    setCancelling(undefined)
    setMessage(text)
    refresh()
    onChanged()
  }
  return (
    <>
      <Card className="inventory-receipts-panel">
        <div className="receipt-panel-heading">
          <div>
            <h2>Recepciones pendientes</h2>
            <p>
              Las unidades pendientes no están disponibles para vender.
              Contabilidad debe revisar el costo y confirmar la cuenta de pago.
            </p>
          </div>
          <div className="receipt-actions">
            <Button
              variant="secondary"
              aria-label="Actualizar recepciones"
              onClick={retry}
            >
              <RefreshCw size={16} /> Actualizar
            </Button>
            {allowCreate && (
              <Button
                disabled={!items.some((item) => item.product.active)}
                onClick={() => setCreating(true)}
              >
                <PackagePlus size={17} /> Recibir mercadería
              </Button>
            )}
          </div>
        </div>
        <Select
          label="Estado de recepciones"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as ReceiptStatus)
            setCursor(undefined)
            setPrevious([])
          }}
        >
          <option value="pending">Pendientes de revisión</option>
          <option value="posted">Contabilizadas</option>
          <option value="cancelled">Canceladas</option>
          <option value="all">Todas</option>
        </Select>
        {message && (
          <p role="status" className="page-feedback">
            {message}
          </p>
        )}
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : !data?.receipts.length ? (
          <p>No hay recepciones en este estado.</p>
        ) : (
          <div className="receipt-list">
            {data.receipts.map((receipt) => (
              <article
                key={receipt.id}
                className="receipt-row"
                aria-label={`Recepción ${receipt.reference || receipt.id.slice(0, 8)}`}
              >
                <div className="receipt-row-heading">
                  <div>
                    <strong>
                      {receipt.reference ||
                        `Recepción ${receipt.id.slice(0, 8)}`}
                    </strong>
                    <p>
                      {receipt.supplier || 'Proveedor sin nombre'} ·{' '}
                      {formatDate(receipt.incurredOn)} · {receipt.units}{' '}
                      unidades
                    </p>
                    <small>
                      Recibió:{' '}
                      {receipt.createdByName || 'Personal de inventario'}
                    </small>
                  </div>
                  <span className="record-badge">
                    {statusLabels[receipt.status]}
                  </span>
                </div>
                {receipt.status === 'posted' && (
                  <p className="muted">Datos informados al recibir:</p>
                )}
                <ul className="receipt-products">
                  {receipt.lines.map((line) => (
                    <li key={line.productId}>
                      {line.productName} · {line.quantity} u. en{' '}
                      {labels.location[line.location]} ·{' '}
                      {formatCurrency(line.unitPrice, receipt.currency)} por
                      unidad
                    </li>
                  ))}
                </ul>
                <p>
                  Envío:{' '}
                  {formatCurrency(receipt.shippingAmount, receipt.currency)}
                  {receipt.currency === 'USD' &&
                    ` · tasa C$ ${receipt.exchangeRate}`}
                </p>
                {receipt.note && <p>{receipt.note}</p>}
                {receipt.status === 'posted' && (
                  <div>
                    <p>
                      Revisó: {receipt.reviewedByName || 'Contabilidad'}. Las
                      unidades se incorporaron al contabilizar.
                    </p>
                    {receipt.posting && (
                      <p>
                        Compra original contabilizada el{' '}
                        {formatDate(receipt.posting.incurredOn)}:{' '}
                        {formatCurrency(
                          receipt.posting.goodsAmount +
                            receipt.posting.shippingAmount,
                          receipt.posting.currency,
                        )}{' '}
                        ·{' '}
                        {receipt.posting.account === 'banco'
                          ? purchaseBankName(receipt.posting.bankLedgerAccount)
                          : receipt.posting.account === 'credito'
                            ? 'Crédito del proveedor'
                            : receipt.posting.account === 'pending'
                              ? 'Clasificación contable'
                              : 'Caja'}
                        {receipt.posting.currency === 'USD' &&
                          ` · tasa C$ ${receipt.posting.exchangeRate}`}
                        {receipt.posting.corrected &&
                          ' · Compra corregida; consulta el historial de Compras.'}
                      </p>
                    )}
                    <p className="muted">
                      El costo y pago vigentes se consultan en Inventario →
                      Compras.
                    </p>
                    {role === 'superadmin' && receipt.shipmentId && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setEditingShipmentId(receipt.shipmentId ?? undefined)
                        }
                      >
                        Editar recepción
                      </Button>
                    )}
                  </div>
                )}
                {receipt.cancelReason && (
                  <p>Motivo de cancelación: {receipt.cancelReason}</p>
                )}
                {receipt.status === 'pending' && (
                  <div className="receipt-actions">
                    {review && (
                      <Button onClick={() => setSelected(receipt)}>
                        Revisar recepción
                      </Button>
                    )}
                    {(review || receipt.createdBy === actorId) && (
                      <Button
                        variant="secondary"
                        onClick={() => setCancelling(receipt)}
                      >
                        Cancelar recepción
                      </Button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        <div className="receipt-pagination">
          <Button
            variant="secondary"
            disabled={!previous.length || loading}
            onClick={() => {
              setCursor(previous.at(-1))
              setPrevious((current) => current.slice(0, -1))
            }}
          >
            Anterior
          </Button>
          <Button
            variant="secondary"
            disabled={!data?.hasMore || loading}
            onClick={() => {
              const last = data?.receipts.at(-1)
              if (last) {
                setPrevious((current) => [...current, cursor])
                setCursor({ createdAt: last.createdAt, id: last.id })
              }
            }}
          >
            Siguiente
          </Button>
        </div>
      </Card>
      {creating && (
        <InventoryReceiptDialog
          items={items}
          onClose={() => setCreating(false)}
          onRecorded={saved}
        />
      )}
      {editingShipmentId && (
        <ReceiptEditor
          id={editingShipmentId}
          onClose={() => setEditingShipmentId(undefined)}
          onSaved={() => saved('Recepción corregida.')}
        />
      )}
      {selected && (
        <ReviewReceipt
          receipt={selected}
          onClose={() => setSelected(undefined)}
          onRecorded={saved}
        />
      )}
      {cancelling && (
        <CancelReceipt
          receipt={cancelling}
          onClose={() => setCancelling(undefined)}
          onRecorded={saved}
        />
      )}
    </>
  )
}

function ReviewReceipt({
  receipt,
  onClose,
  onRecorded,
}: {
  receipt: InventoryReceiptRecord
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { inventoryService, productService, settingsService } = useServices()
  const load = useCallback(async () => {
    const [inventory, pricing, rate, accounts] = await Promise.all([
      inventoryService.getInventory(true),
      productService.listPricing(),
      settingsService.getExchangeRate(),
      journalRpc<LedgerAccount[]>('ledger_accounts_list', {}),
    ])
    return {
      inventory,
      pricing: pricing.rows,
      rate: inventoryExchangeRate(rate),
      advanceAccounts: accounts.filter(
        (account) =>
          account.active &&
          account.postable &&
          account.bucket === 'asset' &&
          (account.code === '1160' || account.parent === '1160'),
      ),
    }
  }, [inventoryService, productService, settingsService])
  const { data, loading, error, retry } = useQuery(load)
  if (!data || loading || error)
    return (
      <Dialog open title="Revisar recepción" onClose={onClose}>
        {error ? (
          <ErrorState message={error} retry={retry} />
        ) : (
          <LoadingState />
        )}
      </Dialog>
    )
  return (
    <PurchaseDialog
      inventory={data.inventory}
      pricing={data.pricing}
      inventoryRate={data.rate}
      initialProduct=""
      reviewingReceipt={receipt}
      advanceAccounts={data.advanceAccounts}
      onClose={onClose}
      onRecorded={onRecorded}
    />
  )
}

function CancelReceipt({
  receipt,
  onClose,
  onRecorded,
}: {
  receipt: InventoryReceiptRecord
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<CancelInventoryReceiptInput, 'requestId'>,
      string
    >(cancelInventoryReceipt, {
      scope: storageScope,
      key: 'inventory-receipt-cancel',
      label: 'Cancelación de recepción',
    }),
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const uncertain = operation.isUncertain()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!uncertain && reason.trim().length < 3) {
      setFailure('Escribe el motivo de cancelación (al menos tres caracteres).')
      return
    }
    setBusy(true)
    setFailure('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          receiptId: receipt.id,
          expectedRevision: receipt.revision,
          reason: reason.trim(),
        })
      onRecorded(
        'Recepción cancelada. Sus unidades no ingresaron al inventario.',
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
      title="Cancelar recepción"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <p>
          Se cancelará{' '}
          {receipt.reference || `la recepción ${receipt.id.slice(0, 8)}`} de{' '}
          {receipt.units} unidades. El registro y su motivo se conservarán en el
          historial.
        </p>
        <fieldset disabled={busy || uncertain} className="form-fields">
          <Input
            label="Motivo de cancelación"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </fieldset>
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Cancelando…'
              : uncertain
                ? 'Verificar guardado'
                : 'Confirmar cancelación'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || uncertain}
            onClick={onClose}
          >
            Volver
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
