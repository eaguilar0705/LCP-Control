import type {
  BusinessSettings,
  CustomerRecord,
  DocumentKind,
  DocumentRecord,
  ExchangeRate,
  InventoryItem,
  MovementRequest,
  NewDocument,
  PriceChange,
  Product,
} from '../lib/domain'
import type { ProductInput } from '../features/products/product'
import type { ReportRange, ReportSource } from '../features/reports/model'
import type {
  ExpenseInput,
  OpeningCostInput,
  ShipmentInput,
} from '../features/reports/accounting'
export interface DataProvider {
  listProducts(): Promise<Product[]>
  saveProduct(input: ProductInput): Promise<string>
  removeProduct(id: string, revision: number): Promise<'archived' | 'deleted'>
  /** Cambios de precio del perfume, del más nuevo al más viejo. Sólo el dueño. */
  listPriceChanges(productId: string): Promise<PriceChange[]>
  /** Costo promedio ponderado en córdobas; `null` mientras no se conozca. */
  getProductCost(productId: string): Promise<number | null>
  uploadProductImage(blob: Blob): Promise<string>
  readonly mode: 'demo' | 'supabase'
  getInventory(includeInactive?: boolean): Promise<InventoryItem[]>
  findByBarcode(code: string): Promise<Product | null>
  getTodaySummary(): Promise<{
    count: number
    totals: { NIO: number; USD: number }
  }>
  getBusiness(): Promise<BusinessSettings>
  /** `null` mientras nadie haya registrado una tasa. */
  getExchangeRate(): Promise<ExchangeRate | null>
  saveExchangeRate(rate: number): Promise<void>
  listCustomers(): Promise<CustomerRecord[]>
  listDocuments(kind: DocumentKind, limit?: number): Promise<DocumentRecord[]>
  /**
   * Todos los documentos de un tipo, del más antiguo al más reciente, para
   * exportarlos. `truncated` avisa si se alcanzó el tope de filas.
   */
  exportDocuments(
    kind: DocumentKind,
  ): Promise<{ documents: DocumentRecord[]; truncated: boolean }>
  /**
   * Elimina una factura emitida: devuelve sus unidades al inventario y la saca
   * de reportes y contabilidad. Sólo Administración. Devuelve el número.
   */
  deleteInvoice(id: string, reason: string): Promise<string>
  createDocument(input: NewDocument): Promise<DocumentRecord>
  recordMovement(input: MovementRequest): Promise<string>
  /** Filas crudas del periodo; los reportes se calculan sobre ellas. */
  getReportSource(range: ReportRange): Promise<ReportSource>
  recordShipment(input: ShipmentInput): Promise<string>
  setOpeningCost(input: OpeningCostInput): Promise<string>
  recordExpense(input: ExpenseInput): Promise<string>
  voidExpense(id: string, reason: string): Promise<string>
}
