import type { DocumentRecord, ShippingMethod } from '../../lib/domain'

export const shippingMethodLabels: Record<ShippingMethod, string> = {
  moto: 'Moto',
  cargotrans: 'CargoTrans',
  buses: 'Buses',
}

export function shippingLabel(
  document: Pick<DocumentRecord, 'shippingMethod'>,
) {
  return document.shippingMethod
    ? `Envío · ${shippingMethodLabels[document.shippingMethod]}`
    : 'Envío'
}
