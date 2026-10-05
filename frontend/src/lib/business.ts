import type { BusinessSettings } from './domain'

/** Reads current settings and the immutable issuer snapshot of older documents. */
export function businessFromRow(row: BusinessSettings & {
  legal_name?: string
  tax_id?: string
  billing_details?: string
}): BusinessSettings {
  return {
    name: row.name,
    address: row.address,
    phone: row.phone,
    legalName: row.legal_name ?? row.legalName ?? '',
    taxId: row.tax_id ?? row.taxId ?? '',
    email: row.email ?? '',
    branch: row.branch ?? '',
    billingDetails: row.billing_details ?? row.billingDetails ?? '',
  }
}

/** One source for the HTML printout and the downloadable PDF; no invented data. */
export function businessIdentityLines(business: BusinessSettings): string[] {
  return [
    business.name,
    business.legalName !== business.name ? business.legalName : '',
    [business.taxId ? `RUC: ${business.taxId}` : '',
      business.branch ? `Sucursal: ${business.branch}` : ''].filter(Boolean).join(' · '),
    business.address,
    [business.phone ? `Tel. ${business.phone}` : '', business.email].filter(Boolean).join(' · '),
    business.billingDetails,
  ].filter((line): line is string => Boolean(line?.trim()))
}
