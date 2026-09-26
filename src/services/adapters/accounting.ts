import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError } from '../../lib/errors'
import {
  emptyAccounting,
  type AccountingSource,
  type ExpenseInput,
  type ExpenseRecord,
  type OpeningCostInput,
  type ShipmentInput,
  type ShipmentLine,
  type ShipmentRecord,
} from '../../features/reports/accounting'
import { addDays, type ReportRange } from '../../features/reports/model'

type DatabaseError = { code?: string; message?: string }
type PageResult = {
  data: unknown[] | null
  error: DatabaseError | null
  count?: number | null
}
const PAGE_SIZE = 500
export const REPORT_ROW_LIMIT = 20000

/** Exact counts also handle projects whose REST row limit is below our page size. */
export async function readReportPages<T>(
  query: (from: number, to: number) => PromiseLike<PageResult>,
  limit = REPORT_ROW_LIMIT,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  while (rows.length < limit) {
    const result = await query(
      rows.length,
      Math.min(rows.length + PAGE_SIZE, limit) - 1,
    )
    if (result.error) throw result.error
    const page = (result.data ?? []) as T[]
    rows.push(...page)
    if (result.count !== null && result.count !== undefined) {
      if (rows.length >= result.count) return { rows, truncated: false }
      if (!page.length) return { rows, truncated: true }
    } else if (page.length < PAGE_SIZE) {
      return { rows, truncated: false }
    }
  }
  return { rows, truncated: true }
}

/** Only missing schema is recoverable; permission, transport and SQL errors surface. */
export function accountingSchemaMissing(error: DatabaseError) {
  return ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(
    error.code ?? '',
  )
}

function numeric(value: unknown): number {
  if (value === null || value === undefined || value === '')
    throw new AppError(
      'unexpected',
      'La contabilidad contiene un importe incompleto.',
    )
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    throw new AppError(
      'unexpected',
      'La contabilidad contiene un importe inválido.',
    )
  return parsed
}
function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : numeric(value)
}
type AccountingRow = Record<string, unknown>

function toShipmentLine(row: AccountingRow): ShipmentLine {
  return {
    id: row.id as string,
    productId: row.product_id as string,
    location: row.location as ShipmentLine['location'],
    quantity: numeric(row.quantity),
    unitPrice: numeric(row.unit_price),
    goodsAmount: numeric(row.goods_amount),
    shippingShare: numeric(row.shipping_share),
    landedUnitCostNio: numeric(row.landed_unit_cost_nio),
  }
}
function toShipment(row: AccountingRow): ShipmentRecord {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    incurredOn: row.incurred_on as string,
    supplier: row.supplier as string,
    agency: row.agency as string,
    reference: row.reference as string,
    note: row.note as string,
    currency: row.currency as ShipmentInput['currency'],
    exchangeRate: numeric(row.exchange_rate),
    shippingAmount: numeric(row.shipping_amount),
    goodsAmount: numeric(row.goods_amount),
    units: numeric(row.units),
    shippingPerUnit: numeric(row.shipping_per_unit),
    createdAt: row.created_at as string,
    lines: ((row.purchase_shipment_lines ?? []) as AccountingRow[]).map(
      toShipmentLine,
    ),
  }
}
function toExpense(row: AccountingRow): ExpenseRecord {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    incurredOn: row.incurred_on as string,
    category: row.category as ExpenseInput['category'],
    description: row.description as string,
    amount: numeric(row.amount),
    currency: row.currency as ExpenseInput['currency'],
    exchangeRate: numeric(row.exchange_rate),
    reference: row.reference as string,
    createdAt: row.created_at as string,
    voidedAt: row.voided_at as string | null,
    voidReason: row.void_reason as string | null,
  }
}

export function createAccountingAdapter(
  client: () => SupabaseClient,
  errorToApp: (error: DatabaseError | null) => AppError,
) {
  async function write(name: string, args: Record<string, unknown>) {
    const { data, error } = await client().rpc(name, args)
    if (error) {
      if (accountingSchemaMissing(error))
        throw new AppError(
          'configuration',
          'Falta aplicar la actualización de contabilidad en Supabase. Contacta al administrador.',
        )
      throw errorToApp(error)
    }
    if (typeof data !== 'string' || !data)
      throw new AppError(
        'unexpected',
        'No se recibió la confirmación del registro contable.',
      )
    return data
  }
  return {
    recordShipment: (input: ShipmentInput) =>
      write('record_shipment', { p_input: input }),
    setOpeningCost: (input: OpeningCostInput) =>
      write('set_opening_cost', { p_input: input }),
    recordExpense: (input: ExpenseInput) =>
      write('record_expense', { p_input: input }),
    voidExpense: (id: string, reason: string) =>
      write('void_expense', { p_id: id, p_reason: reason }),
    /**
     * `lines: false` omite los costos de cada renglón vendido y de cada salida:
     * con el resumen de la base ya vienen sumados y son las tablas que crecen.
     */
    async getSource(
      window: ReportRange,
      { lines = true }: { lines?: boolean } = {},
    ): Promise<AccountingSource> {
      const { data: auth, error: authError } = await client().auth.getUser()
      if (authError) throw errorToApp(authError)
      if (!auth.user)
        throw new AppError(
          'unauthorized',
          'Inicia sesión para consultar los reportes.',
        )
      const { data: staff, error: staffError } = await client()
        .from('staff_members')
        .select('role,active')
        .eq('user_id', auth.user.id)
        .maybeSingle()
      if (staffError) throw errorToApp(staffError)
      if (!staff?.active || !['admin', 'superadmin'].includes(staff.role))
        return structuredClone(emptyAccounting)

      const from = new Date(`${window.from}T00:00:00-06:00`).toISOString()
      const until = new Date(
        `${addDays(window.to, 1)}T00:00:00-06:00`,
      ).toISOString()
      // The role check avoids fetching confidential rows for operational roles;
      // database RLS independently enforces the same rule on every table.
      const results = await Promise.allSettled([
        readReportPages<AccountingRow>((start, end) =>
          client()
            .from('product_costs')
            .select('product_id,average_cost_nio,updated_at', {
              count: 'exact',
            })
            .order('product_id')
            .range(start, end),
        ),
        readReportPages<AccountingRow>((start, end) =>
          client()
            .from('purchase_shipments')
            .select(
              'id,request_id,incurred_on,supplier,agency,reference,note,currency,exchange_rate,shipping_amount,goods_amount,units,shipping_per_unit,created_at,purchase_shipment_lines(id,product_id,location,quantity,unit_price,goods_amount,shipping_share,landed_unit_cost_nio)',
              { count: 'exact' },
            )
            .gte('incurred_on', window.from)
            .lte('incurred_on', window.to)
            .order('incurred_on')
            .order('id')
            .range(start, end),
        ),
        readReportPages<AccountingRow>((start, end) =>
          client()
            .from('expense_records')
            .select(
              'id,request_id,incurred_on,category,description,amount,currency,exchange_rate,reference,created_at,voided_at,void_reason',
              { count: 'exact' },
            )
            .gte('incurred_on', window.from)
            .lte('incurred_on', window.to)
            .order('incurred_on')
            .order('id')
            .range(start, end),
        ),
        lines ? readReportPages<AccountingRow>((start, end) =>
          client()
            .from('document_item_costs')
            .select(
              'document_item_id,document_id,product_id,quantity,unit_cost_nio,net_revenue_nio,tax_nio,documents!inner(created_at)',
              { count: 'exact' },
            )
            .gte('documents.created_at', from)
            .lt('documents.created_at', until)
            .order('document_item_id')
            .range(start, end),
        ) : Promise.resolve({ rows: [] as AccountingRow[], truncated: false }),
        lines ? readReportPages<AccountingRow>((start, end) =>
          client()
            .from('inventory_movement_costs')
            .select(
              'movement_id,product_id,type,quantity,unit_cost_nio,created_at',
              { count: 'exact' },
            )
            .gte('created_at', from)
            .lt('created_at', until)
            .order('movement_id')
            .range(start, end),
        ) : Promise.resolve({ rows: [] as AccountingRow[], truncated: false }),
      ])
      const failures = results.filter((result) => result.status === 'rejected')
      // A missing table must not hide a simultaneous permission or network error.
      const unexpected = failures.find(
        (result) => !accountingSchemaMissing(result.reason ?? {}),
      )
      if (unexpected) throw errorToApp(unexpected.reason)
      if (failures.length) return structuredClone(emptyAccounting)
      const [costs, shipments, expenses, saleCosts, movementCosts] =
        results.map((result) => {
          if (result.status === 'rejected') throw result.reason
          return result.value
        })
      return {
        available: true,
        costs: costs.rows.map((row) => ({
          productId: row.product_id as string,
          averageCostNio: nullableNumeric(row.average_cost_nio),
          updatedAt: row.updated_at as string,
        })),
        shipments: shipments.rows.map(toShipment),
        expenses: expenses.rows.map(toExpense),
        saleCosts: saleCosts.rows.map((row) => ({
          documentId: row.document_id as string,
          productId: row.product_id as string,
          quantity: numeric(row.quantity),
          unitCostNio: nullableNumeric(row.unit_cost_nio),
          netRevenueNio: nullableNumeric(row.net_revenue_nio),
          taxNio: nullableNumeric(row.tax_nio),
        })),
        movementCosts: movementCosts.rows.map((row) => ({
          movementId: row.movement_id as string,
          productId: row.product_id as string,
          type: row.type as 'DAMAGED' | 'EXIT' | 'ADJUSTMENT',
          quantity: numeric(row.quantity),
          unitCostNio: nullableNumeric(row.unit_cost_nio),
          createdAt: row.created_at as string,
        })),
        truncated: [costs, shipments, expenses, saleCosts, movementCosts].some(
          (result) => result.truncated,
        ),
      }
    },
  }
}
