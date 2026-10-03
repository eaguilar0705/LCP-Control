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
  PricingInput,
  PricingList,
  Product,
} from '../lib/domain'
import type { ProductInput } from '../features/products/product'
import type { ReportRange, ReportSource } from '../features/reports/model'
import type { ReportData } from '../features/reports/digest'
import type {
  ExpenseInput,
  OpeningCostInput,
  ShipmentInput,
} from '../features/reports/accounting'
import type {
  CreditLedger,
  FinanceEntryInput,
  FinanceLedger,
} from '../features/accounting/finance'
import type {
  CashClosingInput,
  CashClosingRecord,
  CashflowReport,
} from '../features/accounting/cashflow'
/** Una página del historial dentro de un periodo. */
export interface DocumentQuery {
  range: ReportRange
  offset?: number
  limit?: number
}
export interface DocumentPage {
  documents: DocumentRecord[]
  /** Documentos de todo el periodo, aunque la página traiga menos. */
  total: number
}
/** Los porcentajes de un perfume, con la revisión con que se leyó. */
export interface PricingSave {
  productId: string
  revision: number
  pricing: PricingInput
}
export interface DataProvider {
  listProducts(): Promise<Product[]>
  saveProduct(input: ProductInput): Promise<string>
  removeProduct(id: string, revision: number): Promise<'archived' | 'deleted'>
  /** Cambios de precio del perfume, del más nuevo al más viejo. Sólo el dueño. */
  listPriceChanges(productId: string): Promise<PriceChange[]>
  /** Costo promedio ponderado en córdobas; `null` mientras no se conozca. */
  getProductCost(productId: string): Promise<number | null>
  /**
   * Costo promedio y porcentajes de ganancia (de un perfume o de todos). Sólo
   * los dueños reciben filas. `available` es falso mientras la base no tenga
   * la actualización que los guarda.
   */
  listPricing(productId?: string): Promise<PricingList>
  /**
   * Guarda los porcentajes de uno o varios perfumes y recalcula sus listas
   * desde el costo promedio. Todo o nada. Devuelve cuántos perfumes guardó.
   */
  savePricing(rows: PricingSave[]): Promise<number>
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
  /**
   * Documentos de un tipo emitidos en el periodo (días de Managua, ambos
   * extremos incluidos), del más reciente al más antiguo.
   */
  listDocuments(kind: DocumentKind, query: DocumentQuery): Promise<DocumentPage>
  /**
   * Todos los documentos del periodo, del más antiguo al más reciente, para el
   * PDF. Si pasan de `DOCUMENT_EXPORT_LIMIT` no trae ninguno y pide un rango
   * más corto: un archivo recortado se confundiría con el periodo completo.
   */
  exportDocuments(
    kind: DocumentKind,
    range: ReportRange,
  ): Promise<DocumentRecord[]>
  /**
   * Elimina una factura emitida: devuelve sus unidades al inventario y la saca
   * de reportes y contabilidad. Sólo Administración. Devuelve el número.
   */
  deleteInvoice(id: string, reason: string): Promise<string>
  createDocument(input: NewDocument): Promise<DocumentRecord>
  recordMovement(input: MovementRequest): Promise<string>
  /** Filas crudas del periodo; los reportes se calculan sobre ellas. */
  getReportSource(range: ReportRange): Promise<ReportSource>
  /**
   * El resumen del periodo ya calculado. Quien no lo implementa entrega las
   * filas (`getReportSource`) y el resumen se arma en el navegador.
   */
  getReport?(range: ReportRange): Promise<ReportData>
  recordShipment(input: ShipmentInput): Promise<string>
  setOpeningCost(input: OpeningCostInput): Promise<string>
  recordExpense(input: ExpenseInput): Promise<string>
  voidExpense(id: string, reason: string): Promise<string>
  /** Saldos de caja, bancos y deudas al fin del período y lo registrado en él. */
  getFinance(range: ReportRange): Promise<FinanceLedger>
  /** Deudas por factura, pedido y saldo inicial, con sus abonos a la fecha. */
  getCredits(at: string): Promise<CreditLedger>
  getCashflow(range: ReportRange): Promise<CashflowReport>
  getCashClosings(range: ReportRange): Promise<CashClosingRecord[]>
  recordCashClosing(input: CashClosingInput): Promise<string>
  voidCashClosing(id: string, reason: string): Promise<string>
  recordFinanceEntry(input: FinanceEntryInput): Promise<string>
  voidFinanceEntry(id: string, reason: string): Promise<string>
}
