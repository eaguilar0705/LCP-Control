import type {
  ContactRecord,
  StaffAccount,
  ContactDeletion,
} from '@lcp/contracts/workspace'
export type {
  ContactRecord,
  StaffAccount,
  ContactDeletion,
} from '@lcp/contracts/workspace'
import { supabase } from '../lib/supabase'
import { toAppError } from './adapters/supabase'

function client() {
  if (!supabase)
    throw new Error('Inicia sesión para guardar en la base de datos.')
  return supabase
}
export async function rpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client().rpc(name, args)
  if (error) throw toAppError(error)
  return data as T
}
export async function listContacts(
  kind: 'customers' | 'suppliers',
  id?: string,
): Promise<ContactRecord[]> {
  const query = client().from(kind).select('*').order('name').limit(2000)
  if (id) query.eq('id', id)
  const { data, error } = await query
  if (error) throw toAppError(error)
  return (data ?? []).map((row) => ({
    ...row,
    phone: row.phone ?? '',
    taxId: row.tax_id,
    priceTier: row.price_tier,
  })) as ContactRecord[]
}
export const saveContact = (
  kind: 'customers' | 'suppliers',
  record: ContactRecord,
) =>
  rpc<string>(kind === 'customers' ? 'save_customer' : 'save_supplier', {
    p_payload: record,
  })
/**
 * Elimina un cliente o proveedor. Un cliente con facturas o proformas se
 * archiva en lugar de borrarse, para conservar los documentos emitidos.
 * La revisión evita borrar datos que otra persona acaba de cambiar.
 */
export const deleteContact = (
  kind: 'customers' | 'suppliers',
  record: Pick<ContactRecord, 'id' | 'revision'>,
) =>
  rpc<ContactDeletion>(
    kind === 'customers' ? 'delete_customer' : 'delete_supplier',
    { p_id: record.id, p_revision: record.revision },
  )
export const listStaff = () => rpc<StaffAccount[]>('list_staff_accounts', {})
export const deleteStaff = (record: StaffAccount) =>
  rpc('delete_staff_account', {
    p_email: record.email,
    p_user_id: record.user_id ?? null,
    p_role: record.role,
  })
export const saveStaff = (record: StaffAccount) =>
  rpc('save_staff_account', {
    p_email: record.email,
    p_name: record.display_name,
    p_role: record.role,
    p_active: record.active,
  })
type MovementRow = {
  id: string
  created_at: string
  type: string
  quantity: number
  before_quantity: number | null
  after_quantity: number
  location: string
  note: string
  products:
    { name: string; sku: string } | { name: string; sku: string }[] | null
}
export async function listMovements(): Promise<MovementRow[]> {
  const { data, error } = await client()
    .from('inventory_movements')
    .select(
      'id,created_at,type,quantity,before_quantity,after_quantity,location,note,products(name,sku)',
    )
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw toAppError(error)
  return data ?? []
}
