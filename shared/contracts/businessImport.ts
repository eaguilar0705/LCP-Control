/** Initial migration from the business workbook. Amounts are in NIO unless named USD. */
export interface ImportProduct {
  sku: string
  name: string
  brand: string
  barcode: string | null
  size: number | null
  unit: 'oz' | 'ml'
  category: 'arabian' | 'designer' | 'niche' | null
  gender: 'male' | 'female' | 'unisex' | null
  minimumStock: number
  pricesUSD: {
    emprendedor: number | null
    vip: number | null
    premium: number | null
  }
}

export interface ImportStock {
  sku: string
  warehouse: number | null
  store: number | null
  unitCostNio: number | null
}

export interface ImportAccount {
  code: string
  name: string
  parent: string | null
}

export interface ImportOpeningBalance {
  account: string
  debit: number
  credit: number
}

export interface ImportContact {
  name: string
  phone: string | null
  email: string
  address: string
  taxId: string
  priceTier: 'emprendedor' | 'vip' | 'premium'
}

export interface ImportBusiness {
  name: string
  legalName: string
  taxId: string
  address: string
  phone: string
  email: string
  branch: string
  billingDetails: string
}

export interface BusinessImportData {
  products: ImportProduct[]
  stocks: ImportStock[]
  accounts: ImportAccount[]
  openingBalances: ImportOpeningBalance[]
  customers: ImportContact[]
  suppliers: ImportContact[]
  business: ImportBusiness | null
}

export interface BusinessImportRequest extends BusinessImportData {
  version: 1
  requestId: string
  sourceHash: string
  filename: string
  occurredOn: string
}

export interface BusinessImportResult {
  preview: boolean
  alreadyImported: boolean
  products: number
  stocks: number
  accounts: number
  openingBalances: number
  customers: number
  suppliers: number
  business: boolean
}
