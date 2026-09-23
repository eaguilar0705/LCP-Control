import { describe, expect, it } from 'vitest'
import { buildDocumentsWorkbook, documentsFileName, documentsSheets } from '@/features/sales/documentExport'
import type { DocumentRecord } from '@/lib/domain'

const invoice = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'doc-1',
  kind: 'invoice',
  number: 'FAC-000001',
  customerId: 'c1',
  customerName: 'María López',
  customerPhone: '8888-0000',
  customerTaxId: '001-010190-0000A',
  issuer: { name: 'La Casa del Perfume', address: 'Managua', phone: '2222-0000' },
  tier: 'vip',
  currency: 'USD',
  exchangeRate: 36.6,
  catalogRate: 36.6,
  taxRate: 15,
  total: 115,
  location: 'store',
  validUntil: null,
  paymentMethod: 'card_pos',
  notes: 'Entrega en tienda',
  createdAt: '2026-09-23T02:30:00Z',
  items: [
    { id: 'i1', productId: 'p1', description: 'Perfume A · 100 ml', quantity: 2, unitPrice: 40, lineTotal: 80 },
    { id: 'i2', productId: 'p2', description: 'Perfume B · 50 ml', quantity: 1, unitPrice: 35, lineTotal: 35 },
  ],
  ...overrides,
})

describe('exportación de facturas a Excel', () => {
  it('lleva una fila por factura con todos sus campos y una por renglón', () => {
    const [header, detail] = documentsSheets('invoice', [invoice(), invoice({ id: 'doc-2', number: 'FAC-000002', currency: 'NIO', exchangeRate: 1, paymentMethod: 'pending', taxRate: undefined, total: 500, items: [] })])
    expect(header.name).toBe('Facturas')
    expect(header.rows).toHaveLength(2)
    const first = Object.fromEntries(header.columns.map((column, index) => [column.header, header.rows[0][index]]))
    // 02:30 UTC del 23 es todavía el 22 en Managua.
    expect(first['Fecha']).toBe('2026-09-22')
    expect(first['Hora']).toBe('20:30')
    expect(first['Cliente']).toBe('María López')
    expect(first['Cédula / RUC']).toBe('001-010190-0000A')
    expect(first['Lista de precios']).toBe('VIP')
    expect(first['Subtotal sin impuesto']).toBe(100)
    expect(first['Impuesto incluido']).toBe(15)
    expect(first['Total']).toBe(115)
    expect(first['Total en NIO']).toBe(4209)
    expect(first['Forma de pago']).toBe('POS / Tarjeta')
    expect(first['Salida de']).toBe('Tienda')
    expect(first['Unidades']).toBe(3)
    const second = Object.fromEntries(header.columns.map((column, index) => [column.header, header.rows[1][index]]))
    expect(second['Forma de pago']).toBe('Pendiente de pago')
    expect(second['Subtotal sin impuesto']).toBeNull()
    expect(second['Total en NIO']).toBe(500)
    expect(detail.rows).toHaveLength(2)
    expect(detail.rows[1]).toEqual(['FAC-000001', '2026-09-22', 'María López', 2, 'Perfume B · 50 ml', 1, 35, 35, 'USD', 'VIP', 'p2'])
  })

  it('genera un libro .xlsx y un nombre de archivo con la fecha', async () => {
    const blob = buildDocumentsWorkbook('invoice', [invoice()])
    expect(blob.type).toContain('spreadsheetml')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])
    expect(documentsFileName('invoice', new Date('2026-09-23T18:00:00Z'))).toBe('facturas-2026-09-23.xlsx')
  })
})
