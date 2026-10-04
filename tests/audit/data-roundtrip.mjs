// Auditoría de la base: mete datos de prueba por las mismas funciones que usa
// el programa, con la cuenta de cada rol, comprueba lo que queda escrito y lo
// que cada rol puede leer, prueba datos erróneos contra cada función, borra los
// datos de prueba con las funciones de borrado del programa y, al final, limpia
// el rastro que el programa guarda a propósito. La huella de todas las tablas
// debe volver a ser idéntica a la de antes de empezar.
//
//   node tests/audit/data-roundtrip.mjs
//
// PostgreSQL desechable (PGlite) con todas las migraciones. No toca la base real.
import { createDatabase, fingerprint, USERS } from './harness.mjs'

for (const event of ['unhandledRejection', 'uncaughtException'])
  process.on(event, (e) => {
    console.error('ERROR:', e.message, e.where ?? '', e.params ?? '')
    process.exit(2)
  })
const base = await createDatabase()
const { asOwner, rpc } = base
const { owner, sales, warehouse, admin } = USERS
let checks = 0
let failures = 0
const findings = []
function check(ok, text, detail = '') {
  checks++
  console.log(`${ok ? '✔' : '✘'} ${text}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
async function rejects(promise, pattern, text) {
  try {
    await promise
    check(false, text, 'se aceptó')
  } catch (error) {
    const ok = pattern ? pattern.test(error.message) : true
    check(ok, text, `mensaje: ${error.message}`)
  }
}
const one = async (sql, params) => (await asOwner(sql, params))[0]
const stockOf = async (id, location = 'store') =>
  (
    await one(
      'select quantity from public.inventory_balances where product_id=$1 and location=$2',
      [id, location],
    )
  )?.quantity ?? null
const averageOf = async (id) => {
  const value = (
    await one(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [id],
    )
  )?.average_cost_nio
  return value == null ? null : Number(value)
}
const priceOf = async (id, tier = 'emprendedor', currency = 'NIO') =>
  Number(
    (
      await one(
        'select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency=$3',
        [id, tier, currency],
      )
    )?.amount ?? NaN,
  )
const revisionOf = async (table, id) =>
  (await one(`select revision from public.${table} where id=$1`, [id]))
    ?.revision
const readAs = (user, sql, params = []) =>
  base.asUser(user.id, async () => (await base.db.query(sql, params)).rows)

// --- Datos del negocio simulados (antes de la prueba) ------------------------
const seeded = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000003',
]
const product = (id, name, usd) => ({
  id,
  revision: 0,
  name,
  brand: 'Casa de Prueba',
  size: 100,
  unit: 'ml',
  category: 'arabian',
  gender: 'unisex',
  manufacturerBarcode: '',
  minimumStock: 2,
  active: true,
  imagePath: null,
  prices: {
    emprendedor: { USD: usd, NIO: 0 },
    vip: { USD: usd - 1, NIO: 0 },
    premium: { USD: usd - 2, NIO: 0 },
  },
})
await rpc(owner.id, 'set_exchange_rate', { p_rate: 36.62 })
for (const [index, id] of seeded.entries()) {
  await rpc(owner.id, 'save_catalog_product', {
    p_payload: product(id, `Perfume real ${index + 1}`, 30 + index * 5),
  })
  for (const location of ['store', 'warehouse'])
    await rpc(owner.id, 'record_inventory_movement', {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: id,
        location,
        type: 'ADJUSTMENT',
        quantity: 6 + index,
        note: 'Conteo inicial',
      },
    })
}
await rpc(owner.id, 'set_opening_cost', {
  p_input: {
    requestId: crypto.randomUUID(),
    productId: seeded[0],
    unitCost: 500,
    currency: 'NIO',
    exchangeRate: 1,
    note: 'Costo inicial del negocio',
  },
})
await rpc(owner.id, 'save_product_pricing', {
  p_rows: [
    {
      productId: seeded[0],
      revision: await revisionOf('products', seeded[0]),
      pricing: { markups: { emprendedor: 40, vip: 30, premium: 20 } },
    },
  ],
})
const realCustomer = crypto.randomUUID()
await rpc(owner.id, 'save_customer', {
  p_payload: {
    id: realCustomer,
    revision: 0,
    name: 'Cliente real',
    phone: '88880000',
    priceTier: 'vip',
    email: '',
    taxId: '',
    address: '',
    notes: '',
    active: true,
  },
})
await rpc(owner.id, 'save_supplier', {
  p_payload: {
    id: crypto.randomUUID(),
    revision: 0,
    name: 'Proveedor real',
    active: true,
  },
})
await rpc(sales.id, 'create_document', {
  p_payload: {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerId: realCustomer,
    customerName: 'Cliente real',
    tier: 'vip',
    currency: 'NIO',
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    taxRate: 15,
    items: [{ productId: seeded[0], quantity: 1 }],
  },
})
await rpc(owner.id, 'save_business_settings', {
  p_name: 'Negocio de prueba',
  p_address: 'Managua',
  p_phone: '5555-0100',
})

// Lo que el programa conserva a propósito al borrar (bitácoras) y lo que cambia
// solo con el uso (límites de frecuencia) se revisa aparte.
const LOGS = [
  'private.catalog_changes',
  'private.contact_deletions',
  'private.document_deletions',
  'private.staff_deletions',
  'private.rate_limits',
  'private.document_counters',
  'private.business_actors',
]
const before = await fingerprint(asOwner)
const snapshot = {
  stock: await Promise.all(seeded.map((id) => stockOf(id))),
  average: await averageOf(seeded[0]),
  price: await priceOf(seeded[0]),
}
console.log(
  `Base simulada lista: ${Object.values(before).reduce((n, t) => n + t.rows, 0)} filas en ${Object.keys(before).length} tablas.\n`,
)

// --- 1. Datos erróneos contra cada función: rechazo limpio, nada a medias ---
console.log('1. Datos erróneos')
const bad = [
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: '   ',
        active: true,
        priceTier: 'emprendedor',
      },
    },
    /nombre/,
    'cliente con nombre de espacios',
  ],
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'x'.repeat(161),
        active: true,
        priceTier: 'emprendedor',
      },
    },
    /nombre/,
    'cliente con 161 caracteres',
  ],
  [
    'save_customer',
    owner,
    { p_payload: { id: 'no-es-uuid', revision: 0, name: 'Ana', active: true } },
    /uuid/i,
    'cliente con identificador inválido',
  ],
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'Ana',
        phone: '88880000',
        active: true,
        priceTier: 'emprendedor',
      },
    },
    /teléfono ya está registrado/,
    'cliente con teléfono repetido',
  ],
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'Ana',
        phone: '88-ab',
        active: true,
        priceTier: 'emprendedor',
      },
    },
    null,
    'cliente con teléfono con letras',
  ],
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'Ana',
        active: 'sí',
        priceTier: 'emprendedor',
      },
    },
    /estado/,
    'cliente con estado de texto',
  ],
  [
    'save_customer',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'Ana',
        active: true,
        priceTier: 'oro',
      },
    },
    null,
    'cliente con lista de precios inexistente',
  ],
  [
    'save_customer',
    sales,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'Ana',
        active: true,
        priceTier: 'premium',
      },
    },
    /insufficient|privilege/i,
    'ventas no puede dar lista Premium',
  ],
  [
    'save_supplier',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: '',
        active: true,
      },
    },
    null,
    'proveedor sin nombre',
  ],
  [
    'save_supplier',
    owner,
    {
      p_payload: {
        id: crypto.randomUUID(),
        revision: 0,
        name: 'P',
        notes: 'x'.repeat(5000),
        active: true,
      },
    },
    null,
    'proveedor con notas de 5000 caracteres',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'EXIT',
        quantity: 999,
        note: 'x',
      },
    },
    /negativo|Solo hay|insuficiente/i,
    'salida mayor que las existencias',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'EXIT',
        quantity: -3,
        note: 'x',
      },
    },
    null,
    'cantidad negativa',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'EXIT',
        quantity: 1.5,
        note: 'x',
      },
    },
    null,
    'cantidad con decimales',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'EXIT',
        quantity: 'diez',
        note: 'x',
      },
    },
    null,
    'cantidad de texto',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'sotano',
        type: 'EXIT',
        quantity: 1,
        note: 'x',
      },
    },
    null,
    'ubicación inexistente',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'ROBO',
        quantity: 1,
        note: 'x',
      },
    },
    null,
    'tipo de movimiento inexistente',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'EXIT',
        quantity: 1,
        note: '   ',
      },
    },
    null,
    'motivo en blanco',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: crypto.randomUUID(),
        location: 'store',
        type: 'EXIT',
        quantity: 1,
        note: 'x',
      },
    },
    null,
    'producto inexistente',
  ],
  [
    'record_inventory_movement',
    warehouse,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[0],
        location: 'store',
        type: 'ENTRY',
        quantity: 1,
        note: 'x',
      },
    },
    /Registrar compra/,
    'entrada manual de un perfume con costo',
  ],
  [
    'record_inventory_movement',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 50,
        note: 'x',
      },
    },
    /insufficient|privilege|Solo un dueño/i,
    'ventas no puede ajustar existencias',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: '',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [{ productId: seeded[1], quantity: 1 }],
      },
    },
    null,
    'factura sin cliente',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [],
      },
    },
    null,
    'factura sin productos',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 150,
        items: [{ productId: seeded[1], quantity: 1 }],
      },
    },
    null,
    'impuesto de 150 %',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [{ productId: seeded[1], quantity: 500 }],
      },
    },
    /insuficientes/,
    'factura con más unidades que existencias',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [{ productId: seeded[1], quantity: 0 }],
      },
    },
    null,
    'factura con cantidad 0',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'bitcoin',
        notes: '',
        taxRate: 15,
        items: [{ productId: seeded[1], quantity: 1 }],
      },
    },
    null,
    'forma de pago inexistente',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'EUR',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [{ productId: seeded[1], quantity: 1 }],
      },
    },
    null,
    'moneda EUR',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'proforma',
        customerName: 'Ana',
        tier: 'emprendedor',
        currency: 'NIO',
        notes: '',
        taxRate: 15,
        validUntil: '2020-01-01',
        items: [{ productId: seeded[1], quantity: 1 }],
      },
    },
    null,
    'proforma vencida antes de emitirse',
  ],
  [
    'create_document',
    sales,
    {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: "Ana'); drop table public.products; --",
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        taxRate: 15,
        items: [
          { productId: seeded[1], quantity: 1 },
          { productId: seeded[1], quantity: 1 },
        ],
      },
    },
    null,
    'mismo perfume dos veces en la factura',
  ],
  [
    'save_catalog_product',
    owner,
    { p_payload: { ...product(crypto.randomUUID(), '', 10) } },
    null,
    'perfume sin nombre',
  ],
  [
    'save_catalog_product',
    owner,
    {
      p_payload: {
        ...product(crypto.randomUUID(), 'Perfume', 10),
        prices: {
          emprendedor: { USD: -1, NIO: 0 },
          vip: { USD: 1, NIO: 0 },
          premium: { USD: 1, NIO: 0 },
        },
      },
    },
    null,
    'precio negativo',
  ],
  [
    'save_catalog_product',
    owner,
    {
      p_payload: { ...product(crypto.randomUUID(), 'Perfume', 10), size: -100 },
    },
    null,
    'tamaño negativo',
  ],
  [
    'save_catalog_product',
    owner,
    {
      p_payload: {
        ...product(crypto.randomUUID(), 'Perfume', 10),
        minimumStock: -1,
      },
    },
    null,
    'mínimo negativo',
  ],
  [
    'save_catalog_product',
    owner,
    {
      p_payload: {
        ...product(crypto.randomUUID(), 'Perfume', 10),
        manufacturerBarcode: '123',
      },
    },
    null,
    'EAN de 3 dígitos',
  ],
  [
    'save_catalog_product',
    owner,
    {
      p_payload: { ...product(seeded[1], 'Perfume real 2', 10), revision: 99 },
    },
    /Otro usuario|revisi/i,
    'revisión vieja del perfume',
  ],
  [
    'save_catalog_product',
    sales,
    { p_payload: product(crypto.randomUUID(), 'Perfume', 10) },
    /insufficient|privilege/i,
    'ventas no puede crear perfumes',
  ],
  [
    'save_product_pricing',
    owner,
    {
      p_rows: [
        {
          productId: seeded[1],
          revision: 1,
          pricing: { markups: { emprendedor: -5, vip: null, premium: null } },
        },
      ],
    },
    /0 a 1000/,
    'porcentaje negativo',
  ],
  [
    'save_product_pricing',
    owner,
    {
      p_rows: [
        {
          productId: seeded[1],
          revision: 1,
          pricing: { markups: { emprendedor: 5000, vip: null, premium: null } },
        },
      ],
    },
    /0 a 1000/,
    'porcentaje de 5000',
  ],
  [
    'save_product_pricing',
    sales,
    {
      p_rows: [
        {
          productId: seeded[1],
          revision: 1,
          pricing: { markups: { emprendedor: 5, vip: null, premium: null } },
        },
      ],
    },
    /insufficient|privilege/i,
    'ventas no puede guardar porcentajes',
  ],
  [
    'set_opening_cost',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        unitCost: -10,
        currency: 'NIO',
        exchangeRate: 1,
        note: 'x',
      },
    },
    null,
    'costo inicial negativo',
  ],
  [
    'set_opening_cost',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        productId: seeded[1],
        unitCost: 10,
        currency: 'NIO',
        exchangeRate: 1,
        note: '',
      },
    },
    null,
    'costo inicial sin origen',
  ],
  [
    'record_shipment',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        supplier: 'P',
        agency: 'A',
        reference: 'R',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: -5,
        lines: [
          {
            productId: seeded[1],
            location: 'store',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      },
    },
    null,
    'envío negativo',
  ],
  [
    'record_shipment',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        supplier: 'P',
        agency: 'A',
        reference: 'R',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 5,
        lines: [],
      },
    },
    null,
    'compra sin líneas',
  ],
  [
    'record_shipment',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: 'ayer',
        supplier: 'P',
        agency: 'A',
        reference: 'R',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 5,
        lines: [
          {
            productId: seeded[1],
            location: 'store',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      },
    },
    null,
    'fecha «ayer»',
  ],
  [
    'record_shipment',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        supplier: 'P',
        agency: 'A',
        reference: 'R',
        note: '',
        currency: 'USD',
        exchangeRate: 0,
        shippingAmount: 5,
        lines: [
          {
            productId: seeded[1],
            location: 'store',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      },
    },
    null,
    'compra en dólares con tasa 0',
  ],
  [
    'record_expense',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        category: 'agua_luz',
        description: 'Luz',
        amount: 0,
        currency: 'NIO',
        exchangeRate: 1,
        reference: '',
      },
    },
    null,
    'gasto de 0',
  ],
  [
    'record_expense',
    owner,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        category: 'caprichos',
        description: 'Luz',
        amount: 10,
        currency: 'NIO',
        exchangeRate: 1,
        reference: '',
      },
    },
    null,
    'cuenta de gasto inexistente',
  ],
  [
    'record_expense',
    sales,
    {
      p_input: {
        requestId: crypto.randomUUID(),
        incurredOn: '2026-09-01',
        category: 'agua_luz',
        description: 'Luz',
        amount: 10,
        currency: 'NIO',
        exchangeRate: 1,
        reference: '',
      },
    },
    /insufficient|privilege/i,
    'ventas no puede registrar gastos',
  ],
  ['set_exchange_rate', owner, { p_rate: 0 }, null, 'tasa 0'],
  ['set_exchange_rate', owner, { p_rate: -36 }, null, 'tasa negativa'],
  [
    'set_exchange_rate',
    sales,
    { p_rate: 37 },
    /insufficient|privilege/i,
    'ventas no puede cambiar la tasa',
  ],
  [
    'save_business_settings',
    owner,
    { p_name: '  ', p_address: '', p_phone: '' },
    /negocio/,
    'negocio sin nombre',
  ],
  [
    'save_staff_account',
    owner,
    { p_email: 'ventas@', p_name: 'X', p_role: 'operator', p_active: true },
    null,
    'usuario con correo «ventas@»',
  ],
  [
    'save_staff_account',
    owner,
    {
      p_email: 'nuevo@example.com',
      p_name: 'X',
      p_role: 'dios',
      p_active: true,
    },
    null,
    'rol inexistente',
  ],
  [
    'save_staff_account',
    sales,
    {
      p_email: 'nuevo@example.com',
      p_name: 'X',
      p_role: 'superadmin',
      p_active: true,
    },
    /insufficient|privilege/i,
    'ventas no puede autorizar usuarios',
  ],
  [
    'save_staff_account',
    admin,
    {
      p_email: 'nuevo@example.com',
      p_name: 'X',
      p_role: 'superadmin',
      p_active: true,
    },
    null,
    'un administrador no puede crear un SuperAdmin',
  ],
  [
    'save_my_drafts',
    sales,
    { p_namespace: 'otro.espacio', p_items: [], p_revision: 0 },
    null,
    'borradores en un espacio desconocido',
  ],
  [
    'save_my_drafts',
    sales,
    {
      p_namespace: 'lcp.drafts.invoice.v2',
      p_items: { no: 'lista' },
      p_revision: 0,
    },
    null,
    'borradores que no son una lista',
  ],
  [
    'delete_invoice',
    sales,
    { p_id: crypto.randomUUID(), p_reason: '' },
    /insufficient|privilege/i,
    'ventas no puede eliminar facturas',
  ],
  [
    'delete_customer',
    warehouse,
    { p_id: realCustomer, p_revision: 1 },
    /insufficient|privilege/i,
    'bodega no puede eliminar clientes',
  ],
  [
    'remove_catalog_product',
    owner,
    { p_id: seeded[1], p_revision: 1 },
    /existencias/,
    'no se retira un perfume con existencias',
  ],
  [
    'update_my_profile',
    sales,
    { p_name: '   ' },
    null,
    'nombre propio de espacios',
  ],
]
for (const [name, user, args, pattern, text] of bad) {
  const fp = await fingerprint(asOwner, { exclude: ['private.rate_limits'] })
  await rejects(
    rpc(user.id, name, args),
    pattern,
    `${name}: ${text} → rechazado`,
  )
  const after = await fingerprint(asOwner, { exclude: ['private.rate_limits'] })
  const changed = Object.keys(fp).filter((t) => fp[t].hash !== after[t].hash)
  if (changed.length)
    check(false, `${name}: ${text} → no deja nada a medias`, changed.join(', '))
}
// Anónimo (sin sesión): nada.
for (const table of [
  'customers',
  'products',
  'documents',
  'product_costs',
  'staff_members',
  'suppliers',
])
  await rejects(
    base.asUser(null, () =>
      base.db.query(`select * from public.${table} limit 1`),
    ),
    /permission denied/,
    `sin sesión no se lee ${table}`,
  )
await rejects(
  rpc(null, 'save_customer', {
    p_payload: {
      id: crypto.randomUUID(),
      revision: 0,
      name: 'Anónimo',
      active: true,
    },
  }),
  /permission denied/,
  'sin sesión no se guarda un cliente',
)
const clean = await fingerprint(asOwner, { exclude: ['private.rate_limits'] })
const dirty = Object.keys(clean).filter(
  (t) => t !== 'private.rate_limits' && clean[t].hash !== before[t].hash,
)
check(
  dirty.length === 0,
  'los datos erróneos no cambiaron ninguna tabla',
  dirty.join(', '),
)

// --- 2. Datos de prueba por las funciones del programa -----------------------
console.log('\n2. Datos de prueba')
const T = {
  customer: crypto.randomUUID(),
  supplier: crypto.randomUUID(),
  product: crypto.randomUUID(),
  bare: crypto.randomUUID(),
}
await rpc(owner.id, 'save_customer', {
  p_payload: {
    id: T.customer,
    revision: 0,
    name: 'PRUEBA-AUDITORIA Cliente',
    phone: '88889999',
    priceTier: 'emprendedor',
    email: 'prueba@example.com',
    taxId: 'J0310000000000',
    address: 'Dirección de prueba',
    notes: '<script>alert(1)</script>',
    active: true,
  },
})
await rpc(owner.id, 'save_supplier', {
  p_payload: {
    id: T.supplier,
    revision: 0,
    name: 'PRUEBA-AUDITORIA Proveedor',
    contact: 'Contacto',
    phone: '2222-0000',
    email: 'p@example.com',
    active: true,
  },
})
await rpc(owner.id, 'save_catalog_product', {
  p_payload: product(T.product, 'PRUEBA-AUDITORIA Perfume', 50),
})
await rpc(owner.id, 'save_catalog_product', {
  p_payload: product(T.bare, 'PRUEBA-AUDITORIA Perfume sin uso', 20),
})
check(
  !!(await one('select 1 from public.customers where id=$1 and name=$2', [
    T.customer,
    'PRUEBA-AUDITORIA Cliente',
  ])),
  'cliente de prueba guardado',
)
check(
  !!(await one('select 1 from public.suppliers where id=$1', [T.supplier])),
  'proveedor de prueba guardado',
)
check(
  (await priceOf(T.product, 'emprendedor', 'USD')) === 50 &&
    (await priceOf(T.product, 'emprendedor', 'NIO')) === 1831,
  `perfume de prueba con precio US$ 50 → C$ ${await priceOf(T.product)} (tasa 36.62)`,
)
// Conteo, costo, compra y porcentajes.
for (const location of ['store', 'warehouse'])
  await rpc(warehouse.id, 'record_inventory_movement', {
    p_payload: {
      requestId: crypto.randomUUID(),
      productId: T.product,
      location,
      type: 'ADJUSTMENT',
      quantity: location === 'store' ? 4 : 0,
      note: 'Conteo de prueba',
    },
  })
await rpc(owner.id, 'set_opening_cost', {
  p_input: {
    requestId: crypto.randomUUID(),
    productId: T.product,
    unitCost: 1000,
    currency: 'NIO',
    exchangeRate: 1,
    note: 'Costo de prueba',
  },
})
await rpc(owner.id, 'record_shipment', {
  p_input: {
    requestId: crypto.randomUUID(),
    incurredOn: '2026-09-28',
    supplier: 'PRUEBA-AUDITORIA Proveedor',
    agency: 'Agencia',
    reference: 'PRUEBA-1',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 60,
    lines: [
      {
        productId: T.product,
        location: 'warehouse',
        quantity: 6,
        unitPrice: 1190,
      },
    ],
  },
})
const average = await averageOf(T.product)
check(
  Math.abs(average - (4 * 1000 + 6 * 1200) / 10) < 0.000001,
  `costo promedio (4×1000 + 6×(1190+10)) ÷ 10 = ${average}`,
)
check(
  (await stockOf(T.product, 'warehouse')) === 6,
  'la compra suma 6 u. a bodega',
)
await rpc(owner.id, 'save_product_pricing', {
  p_rows: [
    {
      productId: T.product,
      revision: await revisionOf('products', T.product),
      pricing: {
        purchasePrice: 1190,
        purchaseCurrency: 'NIO',
        markups: { emprendedor: 25, vip: 20, premium: null },
      },
    },
  ],
})
check(
  (await priceOf(T.product)) === 1487.5,
  `precio Emprendedor = compra 1190 × 1,25 = C$ ${await priceOf(T.product)}`,
)
check(
  (await priceOf(T.product, 'vip')) === 1428,
  `precio VIP = compra 1190 × 1,20 = C$ ${await priceOf(T.product, 'vip')}`,
)
// Movimientos de ventas y bodega.
await rpc(warehouse.id, 'record_inventory_movement', {
  p_payload: {
    requestId: crypto.randomUUID(),
    productId: T.product,
    location: 'warehouse',
    type: 'EXIT',
    quantity: 1,
    note: 'Traslado de prueba',
  },
})
await rpc(sales.id, 'record_inventory_movement', {
  p_payload: {
    requestId: crypto.randomUUID(),
    productId: T.product,
    location: 'store',
    type: 'DAMAGED',
    quantity: 1,
    note: 'Frasco roto de prueba',
  },
})
check(
  (await stockOf(T.product)) === 3 &&
    (await stockOf(T.product, 'warehouse')) === 5,
  'salida y dañado descuentan (tienda 3, bodega 5)',
)
// Una petición repetida (doble clic, reintento) no duplica.
const retry = {
  requestId: crypto.randomUUID(),
  productId: T.product,
  location: 'store',
  type: 'DAMAGED',
  quantity: 1,
  note: 'Reintento',
}
await rpc(sales.id, 'record_inventory_movement', { p_payload: retry })
await rpc(sales.id, 'record_inventory_movement', { p_payload: retry })
check(
  (await stockOf(T.product)) === 2,
  'el mismo movimiento enviado dos veces se registra una sola vez',
)
// Factura y proforma de ventas.
const invoicePayload = {
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerId: T.customer,
  customerName: 'PRUEBA-AUDITORIA Cliente',
  customerPhone: '88889999',
  customerTaxId: 'J0310000000000',
  tier: 'emprendedor',
  currency: 'NIO',
  location: 'store',
  paymentMethod: 'bank_transfer',
  notes: 'Factura de prueba',
  taxRate: 15,
  items: [{ productId: T.product, quantity: 2 }],
}
const invoice = await rpc(sales.id, 'create_document', {
  p_payload: invoicePayload,
})
const again = await rpc(sales.id, 'create_document', {
  p_payload: invoicePayload,
})
check(
  invoice.id === again.id,
  `la misma factura enviada dos veces es una sola (${invoice.number})`,
)
check(
  Number(invoice.total) === 2975,
  `total de la factura = 2 × 1487,50 = C$ ${invoice.total}`,
)
check(
  (await stockOf(T.product)) === 0,
  'la factura descuenta las 2 u. de tienda',
)
const proforma = await rpc(sales.id, 'create_document', {
  p_payload: {
    requestId: crypto.randomUUID(),
    kind: 'proforma',
    customerId: T.customer,
    customerName: 'PRUEBA-AUDITORIA Cliente',
    tier: 'emprendedor',
    currency: 'USD',
    exchangeRate: 36.62,
    notes: '',
    taxRate: 0,
    validUntil: '2099-01-01',
    items: [{ productId: T.product, quantity: 3 }],
  },
})
check(
  /^PRO-/.test(proforma.number) &&
    (await stockOf(T.product, 'warehouse')) === 5,
  `proforma ${proforma.number} sin tocar existencias`,
)
await rpc(sales.id, 'save_my_drafts', {
  p_namespace: 'lcp.drafts.invoice.v2',
  p_items: [{ id: 'borrador-prueba', lines: [] }],
  p_revision: 0,
})
check(
  !!(await one('select 1 from public.user_drafts where user_id=$1', [
    sales.id,
  ])),
  'borrador de ventas guardado',
)
await rpc(owner.id, 'save_staff_account', {
  p_email: 'prueba-auditoria@example.com',
  p_name: 'PRUEBA-AUDITORIA Usuario',
  p_role: 'viewer',
  p_active: true,
})
check(
  !!(await one(
    "select 1 from private.pending_staff where email='prueba-auditoria@example.com'",
  )),
  'usuario de prueba autorizado (pendiente de activar)',
)
const expense = await rpc(owner.id, 'record_expense', {
  p_input: {
    requestId: crypto.randomUUID(),
    incurredOn: '2026-09-28',
    category: 'agua_luz',
    description: 'PRUEBA-AUDITORIA Gasto',
    amount: 123.45,
    currency: 'NIO',
    exchangeRate: 1,
    reference: 'PRUEBA',
  },
})
check(!!expense, 'gasto de prueba registrado')
// Los datos del negocio no se movieron.
check(
  JSON.stringify(await Promise.all(seeded.map((id) => stockOf(id)))) ===
    JSON.stringify(snapshot.stock),
  'las existencias de los otros perfumes no cambiaron',
)
check(
  (await averageOf(seeded[0])) === snapshot.average &&
    (await priceOf(seeded[0])) === snapshot.price,
  'el costo y el precio de los otros perfumes no cambiaron',
)

// --- 3. Quién ve qué ---------------------------------------------------------
console.log('\n3. Lectura por rol')
check(
  (await readAs(sales, 'select * from public.product_costs')).length === 0,
  'ventas no ve costos',
)
check(
  (await readAs(sales, 'select * from public.product_pricing')).length === 0,
  'ventas no ve porcentajes',
)
check(
  (await readAs(sales, 'select * from public.expense_records')).length === 0,
  'ventas no ve gastos',
)
check(
  (await readAs(warehouse, 'select * from public.document_item_costs'))
    .length === 0,
  'bodega no ve costos de ventas',
)
check(
  (await readAs(sales, 'select * from public.user_drafts')).length === 1 &&
    (await readAs(owner, 'select * from public.user_drafts')).length === 0,
  'cada quien ve sólo sus borradores',
)
check(
  (
    await readAs(
      owner,
      'select * from public.product_costs where product_id=$1',
      [T.product],
    )
  ).length === 1,
  'la dueña ve el costo del perfume de prueba',
)
const staffSeen = await readAs(sales, 'select * from public.staff_members')
check(
  staffSeen.length === 1 && staffSeen[0].user_id === sales.id,
  `ventas sólo ve su propia cuenta (${staffSeen.length})`,
)

// --- 4. Borrar con las funciones del programa --------------------------------
console.log('\n4. Borrado con el programa')
const deleted = await rpc(owner.id, 'delete_invoice', {
  p_id: invoice.id,
  p_reason: 'Prueba de auditoría',
})
check(deleted === invoice.number, `factura ${deleted} eliminada`)
check(
  (await stockOf(T.product)) === 2,
  'eliminar la factura devuelve las 2 u. a tienda',
)
check(
  Math.abs((await averageOf(T.product)) - 1120) < 0.000001,
  'el costo promedio sigue en 1120 tras devolverlas',
)
check(
  !(await one('select 1 from public.documents where id=$1', [invoice.id])),
  'la factura ya no está en documentos',
)
check(
  !!(await one(
    'select 1 from private.document_deletions where document_id=$1',
    [invoice.id],
  )),
  'queda en la bitácora de facturas eliminadas',
)
await rejects(
  rpc(owner.id, 'delete_invoice', { p_id: proforma.id, p_reason: '' }),
  /Sólo se pueden eliminar facturas/,
  'una proforma no se puede eliminar desde el programa',
)
const customerOutcome = await rpc(owner.id, 'delete_customer', {
  p_id: T.customer,
  p_revision: await revisionOf('customers', T.customer),
})
check(
  customerOutcome === 'archived',
  `el cliente con una proforma se archiva en vez de borrarse (${customerOutcome})`,
)
check(
  (await rpc(owner.id, 'delete_supplier', {
    p_id: T.supplier,
    p_revision: await revisionOf('suppliers', T.supplier),
  })) === 'deleted',
  'proveedor de prueba eliminado',
)
await rejects(
  rpc(owner.id, 'remove_catalog_product', {
    p_id: T.product,
    p_revision: await revisionOf('products', T.product),
  }),
  /existencias/,
  'el perfume con existencias no se deja retirar',
)
for (const location of ['store', 'warehouse'])
  await rpc(warehouse.id, 'record_inventory_movement', {
    p_payload: {
      requestId: crypto.randomUUID(),
      productId: T.product,
      location,
      type: 'ADJUSTMENT',
      quantity: 0,
      note: 'Fin de la prueba',
    },
  })
check(
  (await rpc(owner.id, 'remove_catalog_product', {
    p_id: T.product,
    p_revision: await revisionOf('products', T.product),
  })) === 'archived',
  'el perfume con historial se archiva',
)
check(
  (await rpc(owner.id, 'remove_catalog_product', {
    p_id: T.bare,
    p_revision: await revisionOf('products', T.bare),
  })) === 'deleted',
  'el perfume sin uso se borra del todo',
)
await rpc(owner.id, 'void_expense', {
  p_id: expense,
  p_reason: 'Prueba de auditoría',
})
check(
  !!(await one(
    'select 1 from public.expense_records where id=$1 and voided_at is not null',
    [expense],
  )),
  'el gasto de prueba queda anulado',
)
await rpc(owner.id, 'delete_staff_account', {
  p_email: 'prueba-auditoria@example.com',
  p_user_id: null,
  p_role: 'viewer',
})
check(
  !(await one(
    "select 1 from private.pending_staff where email='prueba-auditoria@example.com'",
  )),
  'usuario de prueba eliminado',
)
await rpc(sales.id, 'save_my_drafts', {
  p_namespace: 'lcp.drafts.invoice.v2',
  p_items: [],
  p_revision: 1,
})

// Lo que el programa deja a propósito (historial) después de borrar.
const afterProgram = await fingerprint(asOwner)
const kept = Object.keys(afterProgram).filter(
  (t) => afterProgram[t].hash !== before[t].hash,
)
const describe = (tables) =>
  tables
    .map((t) => `${t} (${before[t].rows}→${afterProgram[t].rows})`)
    .join(', ')
console.log(
  `   Bitácoras que el programa conserva a propósito: ${describe(kept.filter((t) => LOGS.includes(t)))}`,
)
console.log(
  `   Datos de prueba que el programa no puede borrar: ${describe(kept.filter((t) => !LOGS.includes(t)))}`,
)
findings.push({
  kept: kept.map((t) => ({
    table: t,
    before: before[t].rows,
    after: afterProgram[t].rows,
  })),
})

// --- 5. Limpieza total del rastro de prueba ----------------------------------
console.log('\n5. Limpieza del rastro')
await asOwner(`do $$
declare p uuid[] := array['${T.product}','${T.bare}']::uuid[];
begin
 delete from public.document_item_costs where document_id in (select id from public.documents where customer_id='${T.customer}');
 delete from public.document_items where document_id in (select id from public.documents where customer_id='${T.customer}');
 update public.inventory_movements set document_id=null where document_id in (select id from public.documents where customer_id='${T.customer}');
 delete from public.documents where customer_id='${T.customer}';
 delete from public.customers where id='${T.customer}';
 delete from public.inventory_movement_costs where product_id=any(p);
 delete from public.inventory_movements where product_id=any(p);
 delete from public.purchase_shipment_lines where product_id=any(p);
 delete from public.purchase_shipments where reference='PRUEBA-1';
 delete from public.opening_cost_records where product_id=any(p);
 delete from public.expense_records where description='PRUEBA-AUDITORIA Gasto';
 delete from public.product_pricing where product_id=any(p);
 delete from public.product_costs where product_id=any(p);
 delete from public.product_prices where product_id=any(p);
 delete from public.inventory_balances where product_id=any(p);
 delete from public.products where id=any(p);
 delete from public.user_drafts where user_id='${sales.id}';
 delete from private.catalog_changes where product_id=any(p);
 delete from private.contact_deletions where contact_id in ('${T.customer}','${T.supplier}');
 delete from private.document_deletions where document_id='${invoice.id}';
 delete from private.staff_deletions where target_name='PRUEBA-AUDITORIA Usuario';
 delete from private.rate_limits;
end $$`)
// Los contadores de numeración avanzan con cada documento emitido: se devuelven.
await asOwner(
  `update private.document_counters c set last_value=c.last_value-x.n from (values('invoice',1),('proforma',1)) x(k,n) where c.kind=x.k`,
)
const after = await fingerprint(asOwner)
const residue = Object.keys(after).filter(
  (t) => t !== 'private.rate_limits' && after[t].hash !== before[t].hash,
)
check(
  residue.length === 0,
  'la base vuelve a ser idéntica a como estaba antes de la prueba',
  residue.map((t) => `${t}: ${before[t].rows}→${after[t].rows}`).join(', '),
)
check(
  JSON.stringify(await Promise.all(seeded.map((id) => stockOf(id)))) ===
    JSON.stringify(snapshot.stock) &&
    (await averageOf(seeded[0])) === snapshot.average &&
    (await priceOf(seeded[0])) === snapshot.price,
  'existencias, costos y precios del negocio intactos',
)

console.log(
  `\n${checks - failures} de ${checks} comprobaciones de la base en verde. No se tocó la base real.`,
)
if (process.env.AUDIT_JSON)
  (await import('node:fs')).writeFileSync(
    process.env.AUDIT_JSON,
    JSON.stringify({ checks, failures, findings }, null, 2),
  )
process.exit(failures ? 1 : 0)
