import { beforeEach, expect, it, vi } from 'vitest'
const { query, signed, rpc, eq } = vi.hoisted(() => ({
  query: vi.fn(),
  signed: vi.fn(),
  rpc: vi.fn(),
  eq: vi.fn(),
}))
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      eq(...args)
      return chain
    },
    order: () => chain,
    limit: query,
  }
  return {
    authConfigured: true,
    supabase: {
      from: () => chain,
      rpc,
      storage: { from: () => ({ createSignedUrls: signed }) },
    },
  }
})
import { supabaseAdapter } from '@/services/adapters/supabase'
const row = {
  id: 'test-product',
  revision: 3,
  sku: 'LCP-0001',
  barcode: null,
  name: 'Perfume',
  brands: { name: 'Marca' },
  size: '100',
  unit: 'ml',
  category: 'niche',
  gender: 'unisex',
  active: true,
  minimum_stock: 2,
  image_reference: 'https://drive.google.com/file/d/original/view',
  image_path: 'account/photo.webp',
  product_prices: [
    { tier_code: 'emprendedor', currency: 'NIO', amount: '1200' },
  ],
  inventory_balances: [
    { location: 'warehouse', quantity: null },
    { location: 'store', quantity: 4 },
  ],
}
beforeEach(() => {
  query.mockReset()
  signed.mockReset()
  rpc.mockReset()
  eq.mockReset()
})
it('only includes archived products when explicitly requested and preserves their stock', async () => {
  query.mockResolvedValue({
    data: [{ ...row, active: false, image_path: null }],
    error: null,
  })
  const [item] = await supabaseAdapter.getInventory(true)
  expect(eq).not.toHaveBeenCalledWith('active', true)
  expect(item.product.active).toBe(false)
  expect(item.quantities).toEqual({ warehouse: null, store: 4 })
  await supabaseAdapter.getInventory()
  expect(eq).toHaveBeenCalledWith('active', true)
})
it('loads stored photos once and never derives a Drive thumbnail', async () => {
  query.mockResolvedValue({ data: [row], error: null })
  signed.mockResolvedValue({
    data: [
      {
        path: row.image_path,
        signedUrl: 'https://example.supabase.co/storage/signed/photo',
      },
    ],
    error: null,
  })
  const [item] = await supabaseAdapter.getInventory()
  expect(item.product.imageUrl).toBe(
    'https://example.supabase.co/storage/signed/photo',
  )
  expect(item.product.imageSource).toContain('drive.google.com')
  expect(item.quantities).toEqual({ warehouse: null, store: 4 })
  await supabaseAdapter.getInventory()
  expect(signed).toHaveBeenCalledTimes(1)
})
it('keeps legacy inventory readable before the migration, with pending photos', async () => {
  query
    .mockResolvedValueOnce({ data: null, error: { code: '42703' } })
    .mockResolvedValueOnce({
      data: [{ ...row, image_path: undefined, revision: undefined }],
      error: null,
    })
  const [item] = await supabaseAdapter.getInventory()
  expect(item.product.barcode).toBe('LCP-0001')
  expect(item.product.imageUrl).toBeNull()
  expect(signed).not.toHaveBeenCalled()
})
it('keeps catalogue usable when Storage is unavailable', async () => {
  query.mockResolvedValue({
    data: [{ ...row, image_path: 'new/missing.webp' }],
    error: null,
  })
  signed.mockResolvedValue({
    data: null,
    error: { message: 'storage unavailable' },
  })
  expect((await supabaseAdapter.getInventory())[0].product.imageUrl).toBeNull()
})

it('reads confirmed document lines from the RPC items key', async () => {
  rpc.mockResolvedValue({
    data: {
      id: 'doc',
      kind: 'invoice',
      number: 'FAC-000001',
      customer_id: 'c',
      customer_name: 'Cliente',
      customer_phone: null,
      issuer: { name: 'Negocio', address: '', phone: '' },
      tier_code: 'emprendedor',
      currency: 'NIO',
      total: '1200',
      location: 'store',
      valid_until: null,
      payment_method: 'cash',
      notes: '',
      created_at: '2026-09-13T12:00:00Z',
      items: [
        {
          id: 'line',
          product_id: row.id,
          description: 'Descripción confirmada',
          quantity: 1,
          unit_price: '1200',
          line_total: '1200',
        },
      ],
    },
    error: null,
  })
  const result = await supabaseAdapter.createDocument({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    currency: 'NIO',
    tier: 'emprendedor',
    notes: '',
    items: [{ productId: row.id, quantity: 1 }],
  })
  expect(result.items).toEqual([
    {
      id: 'line',
      productId: row.id,
      description: 'Descripción confirmada',
      quantity: 1,
      unitPrice: 1200,
      lineTotal: 1200,
    },
  ])
})
