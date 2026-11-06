import type {
  CancelInventoryReceiptInput,
  InventoryReceiptInput,
  InventoryReceiptPage,
  InventoryReceiptRecord,
  PostInventoryReceiptInput,
} from '@lcp/contracts/inventoryReceipts'
import { AppError } from '../../lib/errors'
import { journalRpc } from '../accounting/journalService'

export type { InventoryReceiptInput, InventoryReceiptRecord }
export type ReceiptStatus = InventoryReceiptRecord['status'] | 'all'

export async function readInventoryReceipts(
  status: ReceiptStatus = 'pending',
  before?: { createdAt: string; id: string },
) {
  const page = await journalRpc<InventoryReceiptPage>('inventory_receipts', {
    p_input: { status, before, limit: 50 },
  })
  if (
    !Array.isArray(page.receipts) ||
    page.receipts.length > 50 ||
    typeof page.hasMore !== 'boolean' ||
    page.receipts.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        !Number.isInteger(row.revision) ||
        !['pending', 'posted', 'cancelled'].includes(row.status) ||
        !Array.isArray(row.lines) ||
        row.lines.some(
          (line) =>
            !line ||
            typeof line.productId !== 'string' ||
            !Number.isFinite(line.quantity) ||
            !Number.isFinite(line.unitPrice),
        ),
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibió la lista completa de recepciones. Vuelve a intentarlo.',
    )
  return page
}

async function receiptMutation(name: string, input: object) {
  const id = await journalRpc<string>(name, { p_input: input })
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
    throw new AppError(
      'network',
      'No pudimos confirmar el guardado. Usa «Verificar guardado» para recuperar el resultado sin duplicarlo.',
    )
  return id
}

export const recordInventoryReceipt = (input: InventoryReceiptInput) =>
  receiptMutation('record_inventory_receipt', input)
export const postInventoryReceipt = (input: PostInventoryReceiptInput) =>
  receiptMutation('post_inventory_receipt', input)
export const cancelInventoryReceipt = (input: CancelInventoryReceiptInput) =>
  receiptMutation('cancel_inventory_receipt', input)
