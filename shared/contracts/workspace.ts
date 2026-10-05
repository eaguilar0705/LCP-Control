import type { UserRole } from './domain'

export type ContactRecord = {
  id: string
  revision: number
  name: string
  phone: string
  email: string
  taxId: string
  address: string
  notes: string
  active: boolean
  contact?: string
  brands?: string
  terms?: string
  priceTier?: string
}

export type StaffAccount = {
  user_id?: string | null
  email: string
  display_name: string
  role: UserRole
  active: boolean
  registered: boolean
}

export type ContactDeletion = 'deleted' | 'archived'
