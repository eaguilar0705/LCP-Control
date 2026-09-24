import { catalogAdapter } from './adapters/catalog'
import { supabaseAdapter } from './adapters/supabase'
import { unconfiguredAdapter } from './adapters/local'
import { barcodeSchema } from '../lib/validation'
import { AppError } from '../lib/errors'
import { authConfigured } from '../lib/supabase'
import type { DataProvider } from './contracts'
import { lowStockItems } from '../features/inventory/model'
import type { DocumentKind, MovementRequest, NewDocument } from '../lib/domain'
import {
  productInputSchema,
  type ProductInput,
} from '../features/products/product'
import type { ReportRange } from '../features/reports/model'
import type {
  ExpenseInput,
  OpeningCostInput,
  ShipmentInput,
} from '../features/reports/accounting'
export function createServices(provider: DataProvider) {
  return {
    mode: provider.mode,
    productService: {
      listProducts: () => provider.listProducts(),
      saveProduct: (input: ProductInput) =>
        provider.saveProduct(productInputSchema.parse(input)),
      removeProduct: (id: string, revision: number) =>
        provider.removeProduct(id, revision),
      listPriceChanges: (productId: string) =>
        provider.listPriceChanges(productId),
      getProductCost: (productId: string) => provider.getProductCost(productId),
      uploadProductImage: (blob: Blob) => provider.uploadProductImage(blob),
      async findByBarcode(code: string) {
        const parsed = barcodeSchema.safeParse(code)
        if (!parsed.success)
          throw new AppError('validation', parsed.error.issues[0].message)
        return provider.findByBarcode(parsed.data)
      },
    },
    inventoryService: {
      getInventory: (includeInactive = false) =>
        provider.getInventory(includeInactive),
      recordMovement: (input: MovementRequest) =>
        provider.recordMovement(input),
      async getLowStock() {
        return lowStockItems(await provider.getInventory())
      },
    },
    reportService: {
      getSource: (range: ReportRange) => provider.getReportSource(range),
    },
    accountingService: {
      recordShipment: (input: ShipmentInput) =>
        provider.recordShipment(input),
      setOpeningCost: (input: OpeningCostInput) =>
        provider.setOpeningCost(input),
      recordExpense: (input: ExpenseInput) => provider.recordExpense(input),
      voidExpense: (id: string, reason: string) =>
        provider.voidExpense(id, reason),
    },
    settingsService: {
      getExchangeRate: () => provider.getExchangeRate(),
      saveExchangeRate: (rate: number) => provider.saveExchangeRate(rate),
    },
    salesService: {
      getTodaySummary: () => provider.getTodaySummary(),
      getBusiness: () => provider.getBusiness(),
      getExchangeRate: () => provider.getExchangeRate(),
      listCustomers: () => provider.listCustomers(),
      listDocuments: (kind: DocumentKind, limit?: number) =>
        provider.listDocuments(kind, limit),
      exportDocuments: (kind: DocumentKind) => provider.exportDocuments(kind),
      deleteInvoice: (id: string, reason: string) =>
        provider.deleteInvoice(id, reason),
      createDocument: (input: NewDocument) => provider.createDocument(input),
    },
  }
}
// `supabase` is the only mode that reads and writes real records; it requires a
// configured project and a signed-in staff account. The synthetic local catalog
// exists only in development and tests: a production build without Supabase
// fails closed instead of serving a catalogue to anyone.
const dataMode = import.meta.env.VITE_DATA_MODE || 'demo'
export const realDataEnabled = dataMode === 'supabase' && authConfigured
export const privateServices = createServices(
  realDataEnabled ? supabaseAdapter : unconfiguredAdapter,
)
export const demoServices = createServices(
  import.meta.env.DEV ? catalogAdapter : unconfiguredAdapter,
)
