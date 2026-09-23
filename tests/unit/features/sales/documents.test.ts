import { describe, it, expect } from 'vitest'
import {
  defaultValidUntil,
  documentDraftSchema,
  draftPreview,
  draftStorageKey,
  draftTotal,
  isoDate,
  PROFORMA_VALID_DAYS,
  type DocumentDraft,
  type DraftLine,
} from '@/features/sales/document'
import {
  whatsappMessage,
  whatsappNumber,
  whatsappUrl,
} from '@/features/sales/whatsapp'
import { documentFileName } from '@/features/sales/pdf'
import { documentCopy } from '@/lib/domain'
import { equivalentAmount } from '@/lib/pricing'

// Datos inventados: ningún negocio, producto ni teléfono real.
const issuer = {
  name: 'Perfumería de prueba',
  address: 'Dirección de prueba',
  phone: '(+505) 5555-0100',
}
const line: DraftLine = {
  productId: 'demo-0001',
  name: 'Aurora Norte Cedro 01',
  barcode: 'DEMO-0001',
  size: '3.4 oz',
  quantity: 3,
  prices: {
    emprendedor: { NIO: 1000, USD: 25 },
    vip: { NIO: 950, USD: 24 },
    premium: { NIO: 900, USD: 22 },
  },
}
function draft(overrides: Partial<DocumentDraft> = {}): DocumentDraft {
  return {
    id: 'draft-1',
    kind: 'invoice',
    reference: 'FAC-000001',
    customer: 'Tienda Aroma',
    customerId: null,
    phone: '5555 0100',
    taxId: '',
    currency: 'NIO',
    tier: 'emprendedor',
    payment: 'cash',
    location: 'store',
    validUntil: '',
    notes: '',
    createdAt: '2026-09-13T15:00:00.000Z',
    lines: [line],
    ...overrides,
  }
}

describe('separación entre facturas y proformas', () => {
  it('guarda cada tipo en su propio almacenamiento', () => {
    expect(draftStorageKey('invoice')).not.toBe(draftStorageKey('proforma'))
  })
  it('rechaza un borrador sin tipo declarado', () => {
    const { kind: _kind, ...rest } = draft()
    void _kind
    expect(documentDraftSchema.safeParse(rest).success).toBe(false)
  })
  it('no deja que una proforma se lea como factura', () => {
    const proforma = draft({ kind: 'proforma', validUntil: '2026-09-20' })
    const parsed = documentDraftSchema.parse(proforma)
    expect(parsed.kind).toBe('proforma')
    const preview = draftPreview(parsed, issuer)
    expect(preview.kind).toBe('proforma')
    expect(preview.location).toBeNull()
    expect(preview.paymentMethod).toBeNull()
    expect(preview.validUntil).toBe('2026-09-20')
  })
  it('una factura conserva ubicación y forma de pago, y no lleva vigencia', () => {
    const preview = draftPreview(documentDraftSchema.parse(draft()), issuer)
    expect(preview.location).toBe('store')
    expect(preview.paymentMethod).toBe('cash')
    expect(preview.validUntil).toBeNull()
  })
  it('usa sellos y prefijos distintos', () => {
    expect(documentCopy.invoice.stamp).toBe('FACTURA')
    expect(documentCopy.proforma.stamp).toBe('PROFORMA')
    expect(documentCopy.invoice.prefix).not.toBe(documentCopy.proforma.prefix)
  })
})

describe('vigencia de la proforma', () => {
  it('propone siete días desde la emisión', () => {
    const from = new Date('2026-09-13T18:00:00.000Z')
    expect(defaultValidUntil(from)).toBe('2026-09-20')
    expect(PROFORMA_VALID_DAYS).toBe(7)
  })
  it('fecha en la zona horaria de Managua, no en UTC', () => {
    expect(isoDate(new Date('2026-09-14T03:00:00.000Z'))).toBe('2026-09-13')
  })
})

describe('importes del borrador', () => {
  it('respeta lista y moneda', () => {
    expect(draftTotal([line], 'emprendedor', 'NIO')).toBe(3000)
    expect(draftTotal([line], 'premium', 'USD')).toBe(66)
  })
  it('refleja el mismo total en la vista previa compartida', () => {
    const preview = draftPreview(documentDraftSchema.parse(draft()), issuer)
    expect(preview.total).toBe(3000)
    expect(preview.items[0].lineTotal).toBe(3000)
  })
})

describe('número de WhatsApp', () => {
  it('agrega el código de Nicaragua a un número local de ocho dígitos', () => {
    expect(whatsappNumber('5555 0100')).toBe('50555550100')
    expect(whatsappNumber('(+505) 5555-0100')).toBe('50555550100')
  })
  it('respeta un número internacional ya completo', () => {
    expect(whatsappNumber('+1 305 555 0143')).toBe('13055550143')
  })
  it('descarta lo que no sirve', () => {
    for (const value of [null, '', 'sin teléfono', '123'])
      expect(whatsappNumber(value)).toBeNull()
  })
})

describe('equivalente en la otra moneda', () => {
  it('convierte en las dos direcciones con la tasa del catálogo', () => {
    // El catálogo se cotiza en dólares: 212 × 37 son los 7 844 córdobas que
    // aparecen en la lista de precios, y la vuelta tiene que devolver lo mismo.
    expect(equivalentAmount(212, 'USD', 37)).toEqual({
      currency: 'NIO',
      amount: 7844,
    })
    expect(equivalentAmount(7844, 'NIO', 37)).toEqual({
      currency: 'USD',
      amount: 212,
    })
  })
  it('redondea al centavo', () => {
    expect(equivalentAmount(100, 'NIO', 37)?.amount).toBe(2.7)
    expect(equivalentAmount(33.33, 'USD', 36.6)?.amount).toBe(1219.88)
  })
  it('no inventa una conversión cuando falta la tasa', () => {
    for (const rate of [null, undefined, 0, -1, NaN, Infinity])
      expect(equivalentAmount(500, 'NIO', rate)).toBeNull()
    expect(equivalentAmount(NaN, 'NIO', 37)).toBeNull()
  })
})

const NBSP = new RegExp(String.fromCharCode(160), 'g')
describe('mensaje de WhatsApp', () => {
  const invoice = draftPreview(documentDraftSchema.parse(draft()), issuer)
  const proforma = draftPreview(
    documentDraftSchema.parse(
      draft({
        kind: 'proforma',
        reference: 'PRO-000001',
        validUntil: '2026-09-20',
      }),
    ),
    issuer,
  )
  it('nombra el tipo de documento en la primera línea del detalle', () => {
    expect(whatsappMessage(invoice)).toContain('*FACTURA FAC-000001*')
    expect(whatsappMessage(proforma)).toContain('*PROFORMA PRO-000001*')
  })
  it('advierte que una proforma no es una factura', () => {
    const text = whatsappMessage(proforma)
    expect(text).toContain('cotización, no una factura')
    expect(text).toContain('Válida hasta')
    expect(text).not.toContain('Pago:')
  })
  it('incluye cliente, detalle y total', () => {
    // Intl separa el código de moneda con un espacio duro; se normaliza aquí.
    const text = whatsappMessage(invoice).replace(NBSP, ' ')
    expect(text).toContain('Tienda Aroma')
    expect(text).toContain('3 × Aurora Norte Cedro 01 · 3.4 oz')
    expect(text).toContain('*Total: NIO 3,000.00*')
  })
  it('abre el chat del cliente cuando hay teléfono y el selector cuando no', () => {
    expect(whatsappUrl(invoice)).toContain('https://wa.me/50555550100?text=')
    expect(whatsappUrl({ ...invoice, customerPhone: null })).toContain(
      'https://wa.me/?text=',
    )
  })
  it('codifica el texto para la URL', () => {
    expect(whatsappUrl(invoice)).not.toContain(' ')
    expect(decodeURIComponent(whatsappUrl(invoice).split('text=')[1])).toBe(
      whatsappMessage(invoice),
    )
  })
})

describe('nombre del PDF', () => {
  it('usa el número del documento y limpia acentos y símbolos', () => {
    expect(
      documentFileName({
        ...draftPreview(documentDraftSchema.parse(draft()), issuer),
        customerName: 'Perfumería Ñandú S.A.',
      }),
    ).toBe('FAC-000001-Perfumeria-Nandu-S-A.pdf')
  })
})
