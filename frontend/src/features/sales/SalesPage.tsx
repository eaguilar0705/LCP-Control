import { DocumentWorkspace } from './DocumentWorkspace'
// Facturación y Proformas son pantallas distintas a propósito: una cobra y
// descuenta inventario, la otra sólo cotiza. Nunca comparten borradores.
export function SalesPage() {
  return <DocumentWorkspace kind="invoice" />
}
