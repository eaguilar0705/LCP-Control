import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import type {
  BusinessSettings,
  Category,
  Currency,
  CustomerRecord,
  DocumentKind,
  DocumentRecord,
  Gender,
  InventoryItem,
  InventoryLocation,
  MovementRequest,
  NewDocument,
  PaymentMethod,
  PriceChange,
  PriceTier,
  Product,
} from '../../lib/domain'
import type { DataProvider } from '../contracts'
import {
  accountingSchemaMissing,
  createAccountingAdapter,
  readReportPages,
} from './accounting'
import {
  addDays,
  localDay,
  previousRange,
  type ReportRange,
  type ReportSource,
} from '../../features/reports/model'
import {
  DOCUMENT_EXPORT_LIMIT,
  HISTORY_PAGE_SIZE,
  managuaBounds,
} from '../../features/sales/period'

const counts = new Intl.NumberFormat('es-NI')
/** `found` se omite cuando sólo se sabe que pasan del tope. */
function tooManyToExport(kind: DocumentKind, found?: number) {
  const plural = kind === 'invoice' ? 'facturas' : 'proformas'
  const limit = counts.format(DOCUMENT_EXPORT_LIMIT)
  const amount = found ? counts.format(found) : `más de ${limit}`
  return new AppError(
    'validation',
    `El período tiene ${amount} ${plural} y el PDF admite hasta ${limit}. Elige un rango más corto, por ejemplo un mes o una semana.`,
  )
}

interface PriceRow {
  tier_code: PriceTier
  currency: Currency
  amount: number | string
}
interface BalanceRow {
  location: InventoryLocation
  quantity: number | null
}
interface PriceChangeRow {
  changed_at: string
  actor: string
  tier: PriceTier
  before_usd: number | string | null
  after_usd: number | string
  before_nio: number | string | null
  after_nio: number | string
  catalog_rate: number | string | null
}
interface ProductRow {
  revision: number
  image_path: string | null
  id: string
  sku: string
  barcode: string | null
  name: string
  size: number | string | null
  unit: 'oz' | 'ml'
  category: 'arabian' | 'designer' | 'niche' | null
  gender: 'male' | 'female' | 'unisex' | null
  catalog_availability: 'sold_out' | 'unspecified' | null
  image_reference: string | null
  minimum_stock: number | null
  active: boolean
  brands: { name: string } | null
  product_prices: PriceRow[]
  inventory_balances: BalanceRow[]
}
interface DocumentItemRow {
  id: string
  product_id: string
  description: string
  quantity: number
  unit_price: number | string
  line_total: number | string
}
interface DocumentRow {
  exchange_rate?: number | string | null
  catalog_rate?: number | string | null
  tax_rate?: number | string | null
  customer_tax_id?: string
  items?: DocumentItemRow[] | null
  id: string
  kind: DocumentKind
  number: string
  customer_id: string
  customer_name: string
  customer_phone: string | null
  issuer: BusinessSettings
  tier_code: PriceTier
  currency: Currency
  total: number | string
  location: InventoryLocation | null
  valid_until: string | null
  payment_method: PaymentMethod | 'pending' | null
  notes: string
  created_at: string
  document_items: DocumentItemRow[] | null
}

const productSelect = `id,sku,barcode,name,size,unit,category,gender,catalog_availability,
image_reference,image_path,revision,minimum_stock,active,brands(name),
product_prices(tier_code,currency,amount),
inventory_balances(location,quantity)`
const documentSelect = `id,kind,number,customer_id,customer_name,customer_phone,issuer,tier_code,
currency,total,location,valid_until,payment_method,notes,created_at,customer_tax_id,
document_items(id,product_id,description,quantity,unit_price,line_total)`
const documentAccountingColumns = ',exchange_rate,tax_rate,catalog_rate'
function missingDocumentColumns(error: { code?: string } | null) {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

// Read-only screens remain usable while the new migration is being applied.
// Editing still fails explicitly until the write RPCs and columns exist.
async function activeProductRows(
  column?: 'barcode' | 'sku',
  code?: string,
  includeInactive = false,
) {
  async function query(selection: string) {
    let request = client().from('products').select(selection)
    if (!includeInactive) request = request.eq('active', true)
    if (column && code) request = request.eq(column, code)
    return request.order('name').limit(column ? 1 : 2000)
  }
  let result = await query(productSelect)
  if (result.error?.code === '42703' || result.error?.code === 'PGRST204')
    result = await query(productSelect.replace('image_path,revision,', ''))
  if (result.error) fail(result.error)
  const rows = (result.data ?? []) as unknown as ProductRow[]
  await signImages(rows)
  return rows
}

// PostgREST returns numeric as string to preserve precision; parse explicitly.
function amount(value: number | string | null): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return parsed === null || !Number.isFinite(parsed) ? 0 : parsed
}
function client() {
  if (!supabase)
    throw new AppError(
      'configuration',
      'Falta la configuración de Supabase. Revisa VITE_SUPABASE_URL y la clave publicable.',
    )
  return supabase
}
// Supabase errors carry Postgres messages written for the operator in Spanish;
// everything else is reported generically so internals never leak to the screen.
export function toAppError(
  error: { message?: string; code?: string } | null,
): AppError {
  const message = error?.message?.trim()
  const readable = message && message.length <= 300 ? message : null
  if (error?.code === 'PGRST301' || error?.code === '42501')
    return new AppError(
      'unauthorized',
      'Tu cuenta no tiene permiso para esta operación.',
    )
  // HTTP 429 from private.enforce_rate_limit; its message says how long to wait.
  if (error?.code === 'LCP429')
    return new AppError(
      'rate_limited',
      readable ?? 'Demasiadas operaciones seguidas. Espera un momento.',
    )
  if (error?.code === 'P0001')
    return new AppError(
      'validation',
      readable ?? 'Revisa los datos de la operación.',
    )
  return new AppError(
    'unexpected',
    'No pudimos completar la operación. Inténtalo de nuevo.',
  )
}
function fail(error: { message?: string; code?: string } | null): never {
  if (
    error?.code === '42703' ||
    error?.code === 'PGRST202' ||
    error?.code === 'PGRST204'
  )
    throw new AppError(
      'configuration',
      'Falta aplicar la actualización de catálogo e imágenes en Supabase. Contacta al administrador.',
    )
  throw toAppError(error)
}
function emptyPrices(): Record<PriceTier, Record<Currency, number>> {
  return {
    emprendedor: { NIO: 0, USD: 0 },
    vip: { NIO: 0, USD: 0 },
    premium: { NIO: 0, USD: 0 },
  }
}
// Drive is retained only as a manually opened source link. The app loads images
// from its own private Storage bucket; URLs are signed once and reused.
const imageCache = new Map<string, { url: string; expires: number }>()
async function signImages(rows: ProductRow[]) {
  const paths = [
    ...new Set(rows.flatMap((row) => (row.image_path ? [row.image_path] : []))),
  ]
  const missing = paths.filter(
    (path) => (imageCache.get(path)?.expires ?? 0) < Date.now(),
  )
  if (!missing.length) return
  const { data, error } = await client()
    .storage.from('product-images')
    .createSignedUrls(missing, 86400)
  if (error) return // Catalogue stays usable when photo storage is unavailable.
  for (const image of data ?? [])
    if (image.path && image.signedUrl)
      imageCache.set(image.path, {
        url: image.signedUrl,
        expires: Date.now() + 23 * 3600000,
      })
}
function toProduct(row: ProductRow): Product {
  const prices = emptyPrices()
  for (const price of row.product_prices ?? [])
    prices[price.tier_code][price.currency] = amount(price.amount)
  const size = row.size === null ? null : amount(row.size)
  const category: Category = row.category ?? 'unspecified'
  const gender: Gender = row.gender ?? 'unspecified'
  return {
    revision: row.revision,
    imagePath: row.image_path,
    id: row.id,
    barcode: row.sku,
    barcodeKind: 'internal',
    manufacturerBarcode: row.barcode,
    name: row.name,
    brand: row.brands?.name ?? 'Sin marca',
    category,
    gender,
    size,
    unit: row.unit,
    price: prices.emprendedor.NIO,
    currency: 'NIO',
    prices,
    minimumStock: row.minimum_stock ?? null,
    active: row.active,
    availabilityNote:
      row.catalog_availability === 'sold_out' ? 'Agotado' : 'Por confirmar',
    imageUrl: row.image_path
      ? (imageCache.get(row.image_path)?.url ?? null)
      : null,
    imageSource: row.image_reference,
  }
}
function toItem(row: ProductRow): InventoryItem {
  const quantities: Record<InventoryLocation, number | null> = {
    warehouse: null,
    store: null,
  }
  for (const balance of row.inventory_balances ?? [])
    quantities[balance.location] = balance.quantity
  return { product: toProduct(row), quantities }
}
function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerTaxId: row.customer_tax_id ?? '',
    issuer: row.issuer,
    tier: row.tier_code,
    currency: row.currency,
    total: amount(row.total),
    exchangeRate: row.exchange_rate == null ? null : amount(row.exchange_rate),
    catalogRate: row.catalog_rate == null ? null : amount(row.catalog_rate),
    taxRate: row.tax_rate == null ? undefined : amount(row.tax_rate),
    location: row.location,
    validUntil: row.valid_until,
    paymentMethod: row.payment_method,
    notes: row.notes,
    createdAt: row.created_at,
    items: (row.document_items ?? row.items ?? []).map((item) => ({
      id: item.id,
      productId: item.product_id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: amount(item.unit_price),
      lineTotal: amount(item.line_total),
    })),
  }
}

const accounting = createAccountingAdapter(client, toAppError)

/** Catálogo con existencias para los reportes, con sus fotos ya firmadas. */
async function reportInventoryRows() {
  const query = (selection: string) =>
    readReportPages<ProductRow>((start, end) =>
      client()
        .from('products')
        .select(selection, { count: 'exact' })
        .order('id')
        .range(start, end),
    )
  try {
    return await query(productSelect)
  } catch (error) {
    if (!missingDocumentColumns(error as { code?: string })) throw error
    return query(productSelect.replace('image_path,revision,', ''))
  }
}
/** La función de reportes todavía no está instalada en este proyecto. */
function digestMissing(error: { code?: string } | null) {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

export const supabaseAdapter: DataProvider = {
  mode: 'supabase',
  async listProducts() {
    const { data, error } = await client()
      .from('products')
      .select(productSelect)
      .order('name')
      .limit(2000)
    if (error) fail(error)
    const rows = (data ?? []) as unknown as ProductRow[]
    await signImages(rows)
    return rows.map(toProduct)
  },
  async saveProduct(input) {
    const { data, error } = await client().rpc('save_catalog_product', {
      p_payload: input,
    })
    if (error) fail(error)
    return data as string
  },
  async removeProduct(id, revision) {
    const { data, error } = await client().rpc('remove_catalog_product', {
      p_id: id,
      p_revision: revision,
    })
    if (error) fail(error)
    return data as 'archived' | 'deleted'
  },
  async listPriceChanges(productId) {
    const { data, error } = await client().rpc('list_price_changes', {
      p_product: productId,
    })
    if (error) fail(error)
    return ((data ?? []) as PriceChangeRow[]).map(
      (row): PriceChange => ({
        changedAt: row.changed_at,
        actor: row.actor,
        tier: row.tier,
        beforeUsd: row.before_usd === null ? null : Number(row.before_usd),
        afterUsd: Number(row.after_usd),
        beforeNio: row.before_nio === null ? null : Number(row.before_nio),
        afterNio: Number(row.after_nio),
        catalogRate: row.catalog_rate === null ? null : Number(row.catalog_rate),
      }),
    )
  },
  // El rol decide qué se ve: sin permiso sobre la tabla de costos la consulta
  // no falla, devuelve cero filas. El editor lo lee como «todavía sin costo».
  async getProductCost(productId) {
    const { data, error } = await client()
      .from('product_costs')
      .select('average_cost_nio')
      .eq('product_id', productId)
      .maybeSingle()
    if (error) {
      if (accountingSchemaMissing(error)) return null
      fail(error)
    }
    const value = (data as { average_cost_nio: number | string | null } | null)
      ?.average_cost_nio
    return value === null || value === undefined ? null : Number(value)
  },
  async uploadProductImage(blob) {
    const { data: auth, error: authError } = await client().auth.getUser()
    if (authError || !auth.user) fail(authError)
    const path = `${auth.user!.id}/${crypto.randomUUID()}.webp`
    const { error } = await client()
      .storage.from('product-images')
      .upload(path, blob, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: false,
      })
    if (error) fail(error)
    return path
  },
  async getInventory(includeInactive = false) {
    return (await activeProductRows(undefined, undefined, includeInactive)).map(
      toItem,
    )
  },
  // Two equality filters instead of an `or(...)` string: the scanned code is
  // never interpolated into PostgREST filter syntax.
  async findByBarcode(code) {
    for (const column of ['barcode', 'sku'] as const) {
      const [row] = await activeProductRows(column, code)
      if (row) return toProduct(row)
    }
    return null
  },
  async getTodaySummary() {
    const today = localDay(new Date())
    const since = new Date(`${today}T00:00:00-06:00`).toISOString()
    const until = new Date(`${addDays(today, 1)}T00:00:00-06:00`).toISOString()
    const { rows, truncated } = await readReportPages<{
      currency: Currency
      total: number | string
    }>((start, end) =>
      client()
        .from('documents')
        .select('currency,total', { count: 'exact' })
        .eq('kind', 'invoice')
        .gte('created_at', since)
        .lt('created_at', until)
        .order('id')
        .range(start, end),
    ).catch(fail)
    if (truncated)
      throw new AppError('unexpected', 'El resumen diario supera el límite de consulta. Revisa las ventas en Reportes.')
    return {
      count: rows.length,
      totals: {
        NIO: rows
          .filter((row) => row.currency === 'NIO')
          .reduce((sum, row) => sum + amount(row.total), 0),
        USD: rows
          .filter((row) => row.currency === 'USD')
          .reduce((sum, row) => sum + amount(row.total), 0),
      },
    }
  },
  async getBusiness() {
    const { data, error } = await client()
      .from('business_settings')
      .select('name,address,phone')
      .limit(1)
      .maybeSingle()
    if (error) fail(error)
    if (!data)
      throw new AppError(
        'configuration',
        'Falta configurar los datos del negocio en la base de datos.',
      )
    return data as BusinessSettings
  },
  // Sin la migración de la tasa, la pantalla sigue funcionando: se pide a mano
  // en cada documento, que es como se trabajaba antes.
  async getExchangeRate() {
    const { data, error } = await client()
      .from('exchange_rates')
      .select('usd_to_nio,updated_at')
      .limit(1)
      .maybeSingle()
    if (error) {
      if (accountingSchemaMissing(error)) return null
      fail(error)
    }
    if (!data) return null
    const value = Number(data.usd_to_nio)
    return Number.isFinite(value) && value > 0
      ? { usdToNio: value, updatedAt: data.updated_at as string }
      : null
  },
  async saveExchangeRate(rate: number) {
    const { error } = await client().rpc('set_exchange_rate', { p_rate: rate })
    if (error) fail(error)
  },
  async listCustomers() {
    const { data, error } = await client()
      .from('customers')
      .select('id,name,phone,price_tier')
      .order('name')
      .limit(500)
    if (error) fail(error)
    return (
      (data ?? []) as {
        id: string
        name: string
        phone: string | null
        price_tier: PriceTier
      }[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      priceTier: row.price_tier,
    })) satisfies CustomerRecord[]
  },
  // El índice documents(kind, created_at desc) resuelve el filtro por fecha
  // sin recorrer la tabla, aunque haya años de facturas.
  async listDocuments(kind, { range, offset = 0, limit = HISTORY_PAGE_SIZE }) {
    const { from, until } = managuaBounds(range)
    const query = (selection: string) =>
      client()
        .from('documents')
        .select(selection, { count: 'exact' })
        .eq('kind', kind)
        .gte('created_at', from)
        .lt('created_at', until)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit - 1)
    let result = await query(documentSelect + documentAccountingColumns)
    if (missingDocumentColumns(result.error))
      result = await query(documentSelect)
    if (result.error) fail(result.error)
    const documents = ((result.data ?? []) as unknown as DocumentRow[]).map(
      toDocument,
    )
    return { documents, total: result.count ?? offset + documents.length }
  },
  // Paginado igual que los reportes: PostgREST entrega como mucho mil filas por
  // consulta y el PDF tiene que llevar todas las del periodo.
  async exportDocuments(kind, range) {
    const { from, until } = managuaBounds(range)
    const filtered = (selection: string) =>
      client()
        .from('documents')
        .select(selection, { count: 'exact' })
        .eq('kind', kind)
        .gte('created_at', from)
        .lt('created_at', until)
    // Se cuenta primero: un periodo que pasa del tope no se descarga entero
    // para después descartarlo.
    const probe = await filtered('id').order('created_at').range(0, 0)
    if (probe.error) fail(probe.error)
    if (probe.count != null && probe.count > DOCUMENT_EXPORT_LIMIT)
      throw tooManyToExport(kind, probe.count)
    if (probe.count === 0) return []
    const query = (selection: string) =>
      readReportPages<DocumentRow>(
        (start, end) =>
          filtered(selection).order('created_at').order('id').range(start, end),
        DOCUMENT_EXPORT_LIMIT,
      )
    let result
    try {
      result = await query(documentSelect + documentAccountingColumns)
    } catch (error) {
      if (!missingDocumentColumns(error as { code?: string }))
        fail(error as { message?: string; code?: string })
      result = await query(documentSelect)
    }
    // Se emitieron más mientras se descargaba y ya no caben: mejor pedir un
    // rango más corto que entregar un PDF sin las últimas.
    if (result.truncated) throw tooManyToExport(kind)
    return result.rows.map(toDocument)
  },
  async deleteInvoice(id, reason) {
    const { data, error } = await client().rpc('delete_invoice', {
      p_id: id,
      p_reason: reason,
    })
    if (error?.code === 'PGRST202')
      throw new AppError(
        'configuration',
        'Falta aplicar la actualización para eliminar facturas en Supabase (20260924120000_invoice_deletion.sql).',
      )
    if (error) fail(error)
    return data as string
  },
  async createDocument(input: NewDocument) {
    // requestId makes the call idempotent: a retry returns the same document
    // instead of issuing a second one or discounting stock twice.
    const { data, error } = await client().rpc('create_document', {
      p_payload: {
        requestId: input.requestId,
        kind: input.kind,
        customerId: input.customerId ?? null,
        customerName: input.customerName ?? '',
        customerTaxId: input.customerTaxId ?? '',
        customerPhone: input.customerPhone ?? null,
        tier: input.tier,
        currency: input.currency,
        exchangeRate: input.exchangeRate ?? null,
        taxRate: input.taxRate ?? 0,
        location: input.location ?? null,
        paymentMethod: input.paymentMethod ?? null,
        // Una fecha borrada llega como '': la base la recibe como nula y
        // responde «Revisa la vigencia» en lugar de un error de conversión.
        validUntil: input.validUntil || null,
        notes: input.notes,
        items: input.items,
      },
    })
    if (error) fail(error)
    return toDocument(data as unknown as DocumentRow)
  },
  recordShipment: accounting.recordShipment,
  setOpeningCost: accounting.setOpeningCost,
  recordExpense: accounting.recordExpense,
  voidExpense: accounting.voidExpense,
  // Managua no aplica horario de verano, así que el desfase es fijo: el día del
  // negocio va de las 00:00 a las 24:00 en -06:00, no en UTC.
  async getReportSource(range: ReportRange): Promise<ReportSource> {
    // Se carga también el periodo anterior completo: la comparación contra el
    // mes pasado y los clientes que dejaron de comprar se calculan con él.
    const window = { from: previousRange(range).from, to: range.to }
    const from = new Date(`${window.from}T00:00:00-06:00`).toISOString()
    const until = new Date(
      `${addDays(range.to, 1)}T00:00:00-06:00`,
    ).toISOString()
    const reportDocumentSelect =
      'id,kind,number,created_at,currency,total,tier_code,payment_method,location,customer_id,customer_name,document_items(product_id,description,quantity,line_total)'
    async function documentRows() {
      const query = (selection: string) =>
        readReportPages<DocumentRow>((start, end) =>
          client()
            .from('documents')
            .select(selection, { count: 'exact' })
            .gte('created_at', from)
            .lt('created_at', until)
            .order('created_at')
            .order('id')
            .range(start, end),
        )
      try {
        return await query(reportDocumentSelect + documentAccountingColumns)
      } catch (error) {
        if (!missingDocumentColumns(error as { code?: string })) throw error
        return query(reportDocumentSelect)
      }
    }
    type CustomerRow = { id: string; name: string; created_at: string }
    type MovementRow = {
      id: string
      product_id: string
      type: string
      quantity: number
      before_quantity: number | null
      after_quantity: number
      created_at: string
    }
    const results = await Promise.allSettled([
      documentRows(),
      readReportPages<CustomerRow>((start, end) =>
        client()
          .from('customers')
          .select('id,name,created_at', { count: 'exact' })
          .order('id')
          .range(start, end),
      ),
      readReportPages<MovementRow>((start, end) =>
        client()
          .from('inventory_movements')
          .select(
            'id,product_id,type,quantity,before_quantity,after_quantity,created_at',
            { count: 'exact' },
          )
          .gte('created_at', from)
          .lt('created_at', until)
          .order('created_at')
          .order('id')
          .range(start, end),
      ),
      reportInventoryRows(),
      accounting.getSource(window),
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        if (result.reason instanceof AppError) throw result.reason
        fail(result.reason)
      }
    }
    // Inspect every read before unwrapping; a failed source cannot become zeros.
    const unwrap = <T>(result: PromiseSettledResult<T>): T => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    }
    const documents = unwrap(results[0])
    const customers = unwrap(results[1])
    const movements = unwrap(results[2])
    const inventory = unwrap(results[3])
    const financial = unwrap(results[4])
    await signImages(inventory.rows)
    return {
      documents: documents.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        number: row.number,
        createdAt: row.created_at,
        currency: row.currency,
        total: amount(row.total),
        exchangeRate:
          row.exchange_rate == null ? null : amount(row.exchange_rate),
        taxRate: row.tax_rate == null ? undefined : amount(row.tax_rate),
        tier: row.tier_code,
        paymentMethod: row.payment_method,
        location: row.location,
        customerId: row.customer_id,
        customerName: row.customer_name,
        items: (row.document_items ?? []).map((item) => ({
          productId: item.product_id,
          description: item.description,
          quantity: item.quantity,
          lineTotal: amount(item.line_total),
        })),
      })),
      customers: customers.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
      })),
      movements: movements.rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        type: row.type,
        quantity: row.quantity,
        beforeQuantity: row.before_quantity,
        afterQuantity: row.after_quantity,
        createdAt: row.created_at,
      })),
      inventory: inventory.rows.map(toItem),
      accounting: financial,
      window,
      truncated: [documents, customers, movements, inventory, financial].some(
        (result) => result.truncated,
      ),
    }
  },
  // Las ventas, los movimientos y el libro contable llegan ya sumados desde
  // `public.report_digest`: pocos kilobytes aunque el periodo tenga miles de
  // facturas. Sólo el catálogo y las filas contables chicas (costos promedio,
  // pedidos y gastos) se leen tal cual. Si la función todavía no está
  // instalada, se calcula como antes, en el navegador.
  async getReport(range: ReportRange) {
    const digest = await client().rpc('report_digest', {
      p_from: range.from,
      p_to: range.to,
    })
    const { digestFromPayload, digestFromSource } = await import(
      '../../features/reports/digest'
    )
    if (digest.error) {
      if (!digestMissing(digest.error)) throw toAppError(digest.error)
      return digestFromSource(await supabaseAdapter.getReportSource(range), range)
    }
    const results = await Promise.allSettled([
      reportInventoryRows(),
      accounting.getSource(range, { lines: false }),
    ])
    for (const result of results)
      if (result.status === 'rejected') {
        if (result.reason instanceof AppError) throw result.reason
        fail(result.reason)
      }
    const [inventory, financial] = results.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    }) as [
      Awaited<ReturnType<typeof reportInventoryRows>>,
      Awaited<ReturnType<typeof accounting.getSource>>,
    ]
    await signImages(inventory.rows)
    return digestFromPayload(digest.data, {
      range,
      inventory: inventory.rows.map(toItem),
      accounting: financial,
      truncated: inventory.truncated || financial.truncated,
    })
  },
  async recordMovement(input: MovementRequest) {
    const { data, error } = await client().rpc('record_inventory_movement', {
      p_payload: {
        requestId: input.requestId,
        productId: input.productId,
        location: input.location,
        type: input.type,
        quantity: input.quantity,
        reference: input.reference ?? '',
        note: input.note,
      },
    })
    if (error) fail(error)
    return data as string
  },
}
