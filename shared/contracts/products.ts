import type {
  Category,
  Currency,
  Gender,
  PriceTier,
  PricingInput,
} from './domain'

/** Payload accepted when a product is saved, without browser form state. */
export interface ProductInput {
  id: string
  revision: number
  name: string
  brand: string
  category: Category
  gender: Gender
  size: number | null
  unit: 'oz' | 'ml'
  manufacturerBarcode: string
  minimumStock: number
  active: boolean
  imagePath: string | null
  prices: Record<PriceTier, Record<Currency, number>>
  pricing?: PricingInput
}
