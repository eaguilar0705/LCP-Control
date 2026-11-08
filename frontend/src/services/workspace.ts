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
import { readReportPages } from './adapters/accounting'
import { AppError } from '../lib/errors'

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
  const { rows, truncated } = await readReportPages<Record<string, unknown>>(
    (from, to) => {
      const query = client().from(kind).select('*', { count: 'exact' })
      if (id) query.eq('id', id)
      return query.order('name').order('id').range(from, to)
    },
  ).catch((error) => {
    throw toAppError(error)
  })
  if (truncated)
    throw new AppError(
      'unexpected',
      'El registro de contactos supera el límite de consulta. Contacta al administrador.',
    )
  return rows.map((row) => ({
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
export const saveStaff = (
  record: StaffAccount,
  expected: StaffAccount | null,
) =>
  rpc('save_staff_account_checked', {
    p_email: record.email,
    p_name: record.display_name,
    p_role: record.role,
    p_active: record.active,
    p_expected: expected
      ? { ...expected, user_id: expected.user_id ?? null }
      : null,
  })
type MovementRow = {
  id: string
  product_id: string
  created_at: string
  type: string
  quantity: number
  before_quantity: number | null
  after_quantity: number
  adjustment_kind?: 'correction' | 'loss' | null
  counter_account?: string | null
  location: string
  note: string
  request_id?: string | null
  is_invoice_reversal?: boolean
  document_id?: string | null
  voided_at?: string | null
  void_reason?: string | null
  voided_by?: string | null
  reversal_of?: string | null
  products:
    { name: string; sku: string } | { name: string; sku: string }[] | null
}
export async function listMovements(
  day = '',
  offset = 0,
): Promise<MovementRow[]> {
  const query = client()
    .from('inventory_movements')
    .select(
      'id,product_id,created_at,type,quantity,before_quantity,after_quantity,adjustment_kind,counter_account,location,note,request_id,is_invoice_reversal,document_id,voided_at,void_reason,voided_by,reversal_of,products(name,sku)',
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + 50)
  if (day) {
    const start = new Date(`${day}T00:00:00-06:00`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start.getTime()))
      throw new AppError('validation', 'Selecciona una fecha válida.')
    query
      .gte('created_at', start.toISOString())
      .lt('created_at', new Date(start.getTime() + 86400000).toISOString())
  }
  const { data, error } = await query
  if (error) throw toAppError(error)
  return data ?? []
}
