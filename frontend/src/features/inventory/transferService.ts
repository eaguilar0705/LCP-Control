import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import { toAppError } from '../../services/adapters/supabase'
import type { InventoryLocation } from '../../lib/domain'

export interface TransferInput {
  productId: string
  fromLocation: InventoryLocation
  toLocation: InventoryLocation
  quantity: number
  note: string
}
export interface TransferRecord {
  id: string
  product_id: string
  product_sku: string
  product_name: string
  from_location: InventoryLocation
  to_location: InventoryLocation
  quantity: number
  from_before: number
  from_after: number
  to_before: number
  to_after: number
  note: string
  actor_name: string
  created_at: string
}
function client() {
  if (!supabase)
    throw new AppError(
      'configuration',
      'Inicia sesión para registrar el traslado.',
    )
  return supabase
}
export async function transferInventory(
  input: TransferInput & { requestId: string },
): Promise<string> {
  const { data, error } = await client().rpc('transfer_inventory', {
    p_input: input,
  })
  if (error) throw toAppError(error)
  if (typeof data !== 'string' || !data)
    throw new AppError(
      'network',
      'No se pudo confirmar el traslado. Verifica el guardado.',
    )
  return data
}
export async function listTransfers(): Promise<TransferRecord[]> {
  const { data, error } = await client()
    .from('inventory_transfers')
    .select(
      'id,product_id,product_sku,product_name,from_location,to_location,quantity,from_before,from_after,to_before,to_after,note,actor_name,created_at',
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(100)
  if (error) throw toAppError(error)
  return data ?? []
}
