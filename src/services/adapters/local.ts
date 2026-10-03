import { AppError } from '../../lib/errors'
import type { BusinessSettings, DocumentKind } from '../../lib/domain'
import type { DataProvider } from '../contracts'
import { emptyLedger } from '../../features/accounting/finance'
import type { CreditLedger } from '../../features/accounting/finance'
import { emptyCashflow } from '../../features/accounting/cashflow'
import type { ReportRange } from '../../features/reports/model'
// Shared by the catalog and demo providers: the local views read the catalogue
// but must never look as if they issued a document or moved real stock.
// Invented business details: the local view never shows the real ones.
/**
 * El catálogo se cotiza en dólares y el precio en córdobas sale de esta tasa,
 * igual que en la base real. La vista local la usa para que lo que se ve en
 * pantalla —precio, equivalente y tasa— cuadre entre sí. Vive aquí, y no junto
 * al catálogo de muestra, porque ese módulo ya importa de éste.
 */
export const DEMO_EXCHANGE_RATE = 36.6
export const localBusiness: BusinessSettings = {
  name: 'La Casa del Perfume · vista local',
  address: 'Dirección de prueba',
  phone: '(+505) 5555-0100',
}
function unavailable(): never {
  throw new AppError(
    'configuration',
    'La vista local no emite documentos ni modifica inventario o contabilidad. Inicia sesión para trabajar con la base de datos.',
  )
}
function missingConfiguration(): never {
  throw new AppError(
    'configuration',
    'Falta la configuración de Supabase. Esta compilación no incluye datos locales.',
  )
}
// Production build without a configured project: nothing to read or write.
export const unconfiguredAdapter: DataProvider = {
  listProducts: async () => missingConfiguration(),
  saveProduct: async () => missingConfiguration(),
  removeProduct: async () => missingConfiguration(),
  listPriceChanges: async () => missingConfiguration(),
  getProductCost: async () => missingConfiguration(),
  listPricing: async () => missingConfiguration(),
  savePricing: async () => missingConfiguration(),
  uploadProductImage: async () => missingConfiguration(),
  mode: 'demo',
  getInventory: async () => missingConfiguration(),
  findByBarcode: async () => missingConfiguration(),
  getTodaySummary: async () => missingConfiguration(),
  getBusiness: async () => missingConfiguration(),
  getExchangeRate: async () => missingConfiguration(),
  saveExchangeRate: async () => missingConfiguration(),
  listCustomers: async () => missingConfiguration(),
  listDocuments: async () => missingConfiguration(),
  exportDocuments: async () => missingConfiguration(),
  deleteInvoice: async () => missingConfiguration(),
  createDocument: async () => missingConfiguration(),
  recordMovement: async () => missingConfiguration(),
  getReportSource: async () => missingConfiguration(),
  recordShipment: async () => missingConfiguration(),
  setOpeningCost: async () => missingConfiguration(),
  recordExpense: async () => missingConfiguration(),
  voidExpense: async () => missingConfiguration(),
  getFinance: async () => missingConfiguration(),
  getCredits: async () => missingConfiguration(),
  getCashflow: async () => missingConfiguration(),
  getCashClosings: async () => missingConfiguration(),
  recordCashClosing: async () => missingConfiguration(),
  voidCashClosing: async () => missingConfiguration(),
  recordFinanceEntry: async () => missingConfiguration(),
  voidFinanceEntry: async () => missingConfiguration(),
}
export const localWrites = {
  listProducts: async () => unavailable(),
  saveProduct: async () => unavailable(),
  removeProduct: async () => unavailable(),
  uploadProductImage: async () => unavailable(),
  // La vista local no tiene historial ni costos propios: cada catálogo de
  // muestra decide qué enseñar. Sin dato, las secciones quedan vacías.
  async listPriceChanges() {
    return []
  },
  async getProductCost() {
    return null
  },
  async listPricing() {
    return { available: true, rows: [] }
  },
  savePricing: async () => unavailable(),
  async getBusiness(): Promise<BusinessSettings> {
    return { ...localBusiness }
  },
  // La misma tasa con la que se cotizó el catálogo de muestra: el equivalente
  // que se enseña en pantalla tiene que dar el precio de la otra lista.
  async getExchangeRate() {
    return { usdToNio: DEMO_EXCHANGE_RATE, updatedAt: null }
  },
  saveExchangeRate: async () => unavailable(),
  async listCustomers() {
    return []
  },
  async listDocuments(_kind: DocumentKind) {
    void _kind
    return { documents: [], total: 0 }
  },
  async exportDocuments(_kind: DocumentKind) {
    void _kind
    return []
  },
  deleteInvoice: async () => unavailable(),
  createDocument: async () => unavailable(),
  recordMovement: async () => unavailable(),
  recordShipment: async () => unavailable(),
  setOpeningCost: async () => unavailable(),
  recordExpense: async () => unavailable(),
  voidExpense: async () => unavailable(),
  // Sin movimientos propios: la pestaña queda sin saldo inicial.
  async getFinance() {
    return structuredClone(emptyLedger)
  },
  async getCredits(at: string): Promise<CreditLedger> {
    return {
      available: false,
      at,
      startOn: null,
      rows: [],
      unallocatedNio: { receivables: 0, payables: 0 },
      legacyPayments: 0,
    }
  },
  async getCashflow(range: ReportRange) {
    return { ...structuredClone(emptyCashflow), ...range }
  },
  async getCashClosings() {
    return []
  },
  recordCashClosing: async () => unavailable(),
  voidCashClosing: async () => unavailable(),
  recordFinanceEntry: async () => unavailable(),
  voidFinanceEntry: async () => unavailable(),
}
