import { supabase } from '../../lib/supabase'
export type Photo = { kind: 'local' | 'control' | 'upload'; path: string }
export type Content = {
  name: string
  brand: string
  size: string
  unit: string
  category: string
  gender: string
  price: number
  description: string
  availability: string
  featured: boolean
  images: Photo[]
}
export type Draft = {
  id: string
  revision: number
  source_version: number
  reviewed_source_version: number
  source_product_id: string | null
  source_missing: boolean
  source_snapshot: Partial<Content> & {
    active?: boolean
    sku?: string
    image_path?: string
  }
  status: string
  content: Content
  inventory_managed: boolean
  hide_unavailable: boolean
  inventory_state: string
  removal_state: 'pending' | 'kept' | 'accepted' | null
}
export type Publication = {
  id: string
  content: Content
  visible: boolean
  listed: boolean
}
export type CatalogLink = { code: string; name: string; token: string }
export async function catalogLinks(): Promise<CatalogLink[]> {
  const { data, error } = await client().rpc('storefront_catalog_links')
  if (error) throw error
  return data as CatalogLink[]
}
export const statusNames: Record<string, string> = {
  pending: 'Por revisar',
  draft: 'Borrador',
  published: 'Publicado',
  hidden: 'Oculto',
  archived: 'Archivado',
}
export const stockNames: Record<string, string> = {
  available: 'Disponible',
  unavailable: 'Sin existencias',
  unknown: 'Conteo pendiente',
  retired: 'Retirado de Control',
  manual: 'Disponibilidad manual',
}
export const availabilityNames: Record<string, string> = {
  available: 'Disponible',
  unavailable: 'No disponible',
  on_request: 'Por confirmar',
}
export const price = (value: number) =>
  value
    ? new Intl.NumberFormat('es-NI', {
        style: 'currency',
        currency: 'USD',
      }).format(value)
    : 'Consultar precio'
function client() {
  if (!supabase) throw new Error('Configura la conexión a Supabase.')
  return supabase
}
export async function rows<T>(table: string, columns = '*'): Promise<T[]> {
  const all: T[] = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client()
      .from(table)
      .select(columns)
      .order('id')
      .range(offset, offset + 499)
    if (error) throw error
    all.push(...(data as unknown as T[]))
    if (data.length < 500) return all
  }
}
export async function getDraft(id: string): Promise<Draft> {
  const { data, error } = await client()
    .from('storefront_drafts')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data as Draft
}
export async function act(
  action: string,
  draft: Draft,
  content: Content = draft.content,
): Promise<Draft> {
  const { data, error } = await client().rpc('storefront_action', {
    p_action: action,
    p_id: draft.id,
    p_revision: draft.revision,
    p_source_version: draft.source_version,
    p_content: {
      ...content,
      inventory_managed: draft.inventory_managed,
      hide_unavailable: draft.hide_unavailable,
    },
  })
  if (error) throw error
  window.dispatchEvent(new Event('storefront-updated'))
  return data as Draft
}
export async function upload(file: Blob, userId: string): Promise<Photo> {
  const types: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  if (!types[file.type] || file.size > 5 * 1024 * 1024)
    throw new Error('Usa JPG, PNG o WebP de hasta 5 MB.')
  const path = `${userId}/${crypto.randomUUID()}.${types[file.type]}`
  const { error } = await client()
    .storage.from('storefront-media')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  return { kind: 'upload', path }
}
export async function photoBlob(photo: Photo) {
  const { data, error } = await client()
    .storage.from(
      photo.kind === 'control' ? 'product-images' : 'storefront-media',
    )
    .download(photo.path)
  if (error) throw error
  return data
}
export function localPhoto(photo: Photo) {
  return photo.kind === 'local' &&
    /^images\/productos\/[\w-]+\.(webp|png|jpe?g)$/.test(photo.path)
    ? `/storefront/${photo.path}`
    : null
}
export function blank(): Draft {
  return {
    id: crypto.randomUUID(),
    revision: 0,
    source_version: 0,
    reviewed_source_version: 0,
    source_product_id: null,
    source_missing: false,
    source_snapshot: {},
    status: 'draft',
    inventory_managed: false,
    hide_unavailable: false,
    inventory_state: 'manual',
    removal_state: null,
    content: {
      name: '',
      brand: '',
      size: '',
      unit: 'ml',
      category: 'arabian',
      gender: 'unisex',
      price: 0,
      description: '',
      availability: 'on_request',
      featured: false,
      images: [],
    },
  }
}
