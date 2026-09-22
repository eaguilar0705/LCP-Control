import { ProductSelect } from '../../components/ProductSelect'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ArrowDownLeft, ArrowUpRight, TriangleAlert } from 'lucide-react'
import { Button, Card, Dialog, Input, Select } from '../../components/ui'
import { useLocalDrafts } from '../../lib/localDrafts'
import { formatDate } from '../../lib/format'
import { labels, type InventoryItem } from '../../lib/domain'
const movementSchema = z.object({
  id: z.string(),
  productId: z.string().min(1),
  productName: z.string(),
  type: z.enum(['ENTRY', 'EXIT', 'DAMAGED']),
  location: z.enum(['warehouse', 'store']),
  quantity: z.number().int().min(1).max(99999),
  note: z.string().trim().min(1).max(1000),
  createdAt: z.string(),
})
type DraftMovementType = z.infer<typeof movementSchema>['type']
const movementLabels = { ENTRY: 'Entrada', EXIT: 'Salida', DAMAGED: 'Dañado' }
export function MovementDrafts({ items }: { items: InventoryItem[] }) {
  const [type, setType] = useState<DraftMovementType | null>(null)
  const {
    items: drafts,
    save,
    error,
  } = useLocalDrafts('lcp.movements.v1', movementSchema)
  return (
    <section className="movement-section">
      <div className="movement-buttons">
        {(
          [
            ['ENTRY', ArrowDownLeft],
            ['EXIT', ArrowUpRight],
            ['DAMAGED', TriangleAlert],
          ] as const
        ).map(([id, Icon]) => (
          <Button key={id} variant="secondary" onClick={() => setType(id)}>
            <Icon size={18} />
            {movementLabels[id]}
          </Button>
        ))}
      </div>
      <p className="workspace-disclaimer">
        Prepara movimientos pendientes. Las cantidades de inventario no cambian.
      </p>
      {drafts.length > 0 && (
        <Card className="movement-history">
          <h2>Movimientos pendientes ({drafts.length})</h2>
          {drafts.map((draft) => (
            <div key={draft.id}>
              <strong>
                {movementLabels[draft.type]} · {draft.productName}
              </strong>
              <span>
                {draft.quantity} uds. · {labels.location[draft.location]} ·{' '}
                {formatDate(draft.createdAt)}
              </span>
              <p>{draft.note}</p>
            </div>
          ))}
        </Card>
      )}
      {type && (
        <MovementForm
          key={type}
          type={type}
          items={items}
          onClose={() => setType(null)}
          onSave={(draft) => {
            if (save([draft, ...drafts])) {
              setType(null)
              return true
            }
            return false
          }}
          error={error}
        />
      )}
    </section>
  )
}
function MovementForm({
  type,
  items,
  onClose,
  onSave,
  error,
}: {
  type: DraftMovementType
  items: InventoryItem[]
  onClose: () => void
  onSave: (draft: z.infer<typeof movementSchema>) => boolean
  error: string
}) {
  const [productId, setProductId] = useState('')
  const [message, setMessage] = useState('')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const product = items.find((item) => item.product.id === productId)?.product
    const result = movementSchema.safeParse({
      id: crypto.randomUUID(),
      productId,
      productName: product?.name ?? '',
      type,
      location: data.get('location'),
      quantity: Number(data.get('quantity')),
      note: data.get('note'),
      createdAt: new Date().toISOString(),
    })
    if (!product || !result.success) {
      setMessage(
        'Selecciona un producto, una cantidad entera positiva y el motivo.',
      )
      return
    }
    onSave(result.data)
  }
  return (
    <Dialog
      open
      title={`${movementLabels[type]} de inventario`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="movement-form">
        <ProductSelect
          label="Producto del movimiento"
          products={items.map(({ product }) => product)}
          value={productId}
          onChange={setProductId}
        />
        <div className="form-grid">
          <Select label="Ubicación" name="location">
            <option value="warehouse">Bodega</option>
            <option value="store">Tienda</option>
          </Select>
          <Input
            label="Cantidad"
            name="quantity"
            type="number"
            min={1}
            max={99999}
            step={1}
            required
          />
        </div>
        <Input
          label={
            type === 'ENTRY' ? 'Proveedor o motivo de la entrada' : 'Motivo'
          }
          name="note"
          maxLength={1000}
          required
        />
        <p className="workspace-disclaimer">
          Se guardará como pendiente en este navegador. No modifica las
          existencias.
        </p>
        {(message || error) && (
          <p role="alert" className="inline-error">
            {message || error}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit">Guardar movimiento pendiente</Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
