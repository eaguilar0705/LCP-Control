import type { UserRole } from './domain'
export type Capability =
  | 'inventory.read'
  | 'scanner.use'
  | 'sale.create'
  | 'product.manage'
  | 'product.edit_cost'
  | 'inventory.create_entry'
  | 'inventory.create_exit'
  | 'inventory.create_damage'
  | 'inventory.adjust'
  | 'finance.read'
  | 'customer.read'
  | 'customer.manage'
  | 'customer.delete'
  | 'supplier.read'
  | 'supplier.manage'
  | 'supplier.delete'
  | 'document.delete'
  | 'staff.manage'
  | 'settings.manage'
const common: Capability[] = [
  'inventory.read',
  'scanner.use',
  'sale.create',
  'inventory.create_exit',
  'inventory.create_damage',
  'customer.read',
  'customer.manage',
]
const permissions: Record<UserRole, readonly Capability[]> = {
  superadmin: [
    ...common,
    'product.manage',
    'product.edit_cost',
    'inventory.create_entry',
    'inventory.adjust',
    'finance.read',
    'supplier.read',
    'supplier.manage',
    'customer.delete',
    'supplier.delete',
    'document.delete',
    'staff.manage',
    'settings.manage',
  ],
  admin: [
    ...common,
    'product.manage',
    'product.edit_cost',
    'inventory.create_entry',
    'inventory.adjust',
    'finance.read',
    'supplier.read',
    'supplier.manage',
    'customer.delete',
    'supplier.delete',
    'document.delete',
    'staff.manage',
    'settings.manage',
  ],
  operator: common,
  warehouse: [
    'inventory.read',
    'scanner.use',
    'inventory.create_entry',
    'inventory.create_exit',
    'inventory.create_damage',
    'inventory.adjust',
    'supplier.read',
  ],
  viewer: ['inventory.read', 'scanner.use'],
}
export function can(
  role: UserRole | null | undefined,
  capability: Capability,
): boolean {
  return !!role && permissions[role].includes(capability)
}
// Missing / invalid roles fail closed. Never authorize from user_metadata.
export function parseRole(value: unknown): UserRole | null {
  return typeof value === 'string' && Object.hasOwn(permissions, value)
    ? (value as UserRole)
    : null
}
export const roleLabels: Record<UserRole, string> = {
  superadmin: 'SuperAdmin',
  admin: 'Administrador',
  operator: 'Ventas',
  warehouse: 'Inventario',
  viewer: 'Solo consulta',
}
