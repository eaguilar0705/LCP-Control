import type { DocumentRecord, PricingInput } from './domain'
import type { ReportRange } from './reports'

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
