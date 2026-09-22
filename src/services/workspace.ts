import { supabase } from '../lib/supabase'
import { toAppError } from './adapters/supabase'
import type { UserRole } from '../lib/domain'
export type ContactRecord = {
  id: string
  revision: number
  name: string
  phone: string
  email: string
  taxId: string
  address: string
  notes: string
  active: boolean
  contact?: string
  brands?: string
  terms?: string
  priceTier?: string
}
export type StaffAccount = {
  user_id?: string | null
  email: string
  display_name: string
  role: UserRole
  active: boolean
  registered: boolean
}
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
): Promise<ContactRecord[]> {
  const { data, error } = await client()
    .from(kind)
    .select('*')
    .order('name')
    .limit(2000)
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
