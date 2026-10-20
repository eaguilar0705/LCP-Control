import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/business-import-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const {
  parseBusinessImportRows,
  readBusinessWorkbook,
  businessImportTemplate,
} = await server.ssrLoadModule(
  '/src/features/administration/businessImportWorkbook.ts',
)

const sheet = (name, headers, ...rows) => ({ name, rows: [headers, ...rows] })
const stock = (...rows) =>
  sheet(
    'Existencias',
    ['sku', 'bodega', 'tienda', 'costo_unitario_nio'],
    ...rows,
  )
const products = (...rows) =>
  sheet('Productos', ['sku', 'nombre', 'marca'], ...rows)

test('maps Spanish business migration sheets without inventing unknown stock or cost', () => {
  const result = parseBusinessImportRows([
    sheet(
      'Instrucciones',
      ['Información'],
      ['Esto no es información para importar'],
    ),
    sheet(
      'Productos',
      [
        'sku',
        'nombre',
        'marca',
        'codigo_barras',
        'tamano',
        'unidad',
        'categoria',
        'genero',
        'minimo',
        'precio_emprendedor_usd',
        'precio_vip_usd',
        'precio_premium_usd',
      ],
      [
        'SKU-001',
        'Perfume',
        'Marca',
        '00001234',
        100,
        'ml',
        'Árabe',
        'mujer',
        2,
        15.5,
        16,
        18,
      ],
    ),
    stock(['SKU-001', 0, 8, 120.25], ['SKU-002', null, 3, null]),
    sheet(
      'Cuentas',
      ['codigo', 'nombre', 'padre'],
      ['1130-001', 'Inventario importado', '1130'],
    ),
    sheet(
      'Saldos',
      ['cuenta', 'debe', 'haber'],
      ['1130', 1000, 0],
      ['3110-001', 0, 1000],
    ),
    sheet(
      'Clientes',
      ['nombre', 'telefono', 'correo', 'direccion', 'ruc', 'nivel'],
      [
        'Cliente',
        '50588881234',
        'cliente@example.com',
        'Managua',
        '001',
        'vip',
      ],
    ),
    sheet('Proveedores', ['nombre'], ['Proveedor']),
    sheet(
      'Negocio',
      [
        'nombre',
        'razon_social',
        'ruc',
        'direccion',
        'telefono',
        'correo',
        'sucursal',
        'datos_facturacion',
      ],
      [
        'La Casa del Perfume',
        'Casa SA',
        '0012',
        'Managua',
        '2222',
        'info@example.com',
        'Central',
        'Datos fiscales',
      ],
    ),
  ])
  assert.deepEqual(result.problems, [])
  assert.equal(result.data.products[0].barcode, '00001234')
  assert.equal(result.data.products[0].category, 'arabian')
  assert.equal(result.data.products[0].gender, 'female')
  assert.deepEqual(result.data.stocks, [
    { sku: 'SKU-001', warehouse: 0, store: 8, unitCostNio: 120.25 },
    { sku: 'SKU-002', warehouse: null, store: 3, unitCostNio: null },
  ])
  assert.equal(result.data.suppliers[0].priceTier, 'emprendedor')
  assert.equal(result.data.customers[0].phone, '50588881234')
  assert.equal(result.data.business.taxId, '0012')
  assert.equal(result.data.openingBalances.length, 2)
})

test('rejects unsupported or duplicate sheets, unknown/duplicate headers and data in unnamed columns', () => {
  for (const workbook of [
    [sheet('Hoja1', ['sku'], ['001'])],
    [
      products(['001', 'Perfume', 'Marca']),
      products(['002', 'Perfume 2', 'Marca']),
    ],
    [
      sheet(
        'Existencias',
        ['sku', 'bodega', 'tienda', 'estante'],
        ['001', 1, 2, 'A'],
      ),
    ],
    [
      sheet(
        'Existencias',
        ['sku', 'bodega', 'tienda', 'BODEGA'],
        ['001', 1, 2, 3],
      ),
    ],
    [stock(['001', 1, 2, null, 'dato perdido'])],
    [sheet('Productos', ['sku', 'nombre'], ['001', 'Perfume'])],
  ])
    assert.ok(parseBusinessImportRows(workbook).problems.length)
})

test('rejects negative/fractional stock and ambiguous numeric text while retaining explicit blanks', () => {
  for (const value of [
    -1,
    0.5,
    'no',
    '1,000',
    'C$20',
    Infinity,
    100000001,
    '1e2',
  ]) {
    assert.ok(
      parseBusinessImportRows([stock(['001', value, 0, null])]).problems.length,
      String(value),
    )
  }
  assert.ok(
    parseBusinessImportRows([stock(['001', null, null, null])]).problems.length,
  )
  assert.deepEqual(
    parseBusinessImportRows([stock(['001', null, null, 10.123456])]).problems,
    [],
  )
  assert.deepEqual(
    parseBusinessImportRows([stock(['001', '', 0, ''])]).data.stocks[0],
    { sku: '001', warehouse: null, store: 0, unitCostNio: null },
  )
  assert.ok(
    parseBusinessImportRows([stock(['001', 1, 0, 1.0000001])]).problems.some(
      (p) => p.message.includes('decimales'),
    ),
  )
  assert.deepEqual(
    parseBusinessImportRows([stock(['001', 1, 0, 1.123456])]).problems,
    [],
  )
})

test('rejects formula and error cells even if other required values are present', () => {
  const result = parseBusinessImportRows([
    stock(['001', { error: 'No se admiten fórmulas.' }, 2, null]),
  ])
  assert.ok(
    result.problems.some(
      (problem) =>
        problem.sheet === 'Existencias' &&
        problem.row === 2 &&
        problem.message.includes('fórmulas'),
    ),
  )
})

test('rejects duplicate SKU, account, customer and opening account keys', () => {
  for (const workbook of [
    [products(['SKU', 'Uno', 'Marca'], ['sku', 'Dos', 'Marca'])],
    [stock(['SKU', 1, 0, null], ['sku', 2, 0, null])],
    [sheet('Cuentas', ['codigo', 'nombre'], ['1130', 'Uno'], ['1130', 'Dos'])],
    [sheet('Clientes', ['nombre'], ['Ana'], ['ana'])],
    [
      sheet(
        'Saldos',
        ['cuenta', 'debe', 'haber'],
        ['1130', 1, 0],
        ['1130', 0, 1],
      ),
    ],
  ])
    assert.ok(
      parseBusinessImportRows(workbook).problems.some((p) =>
        p.message.includes('duplicado'),
      ),
    )
})

test('opening balances must balance, have one positive side and stay within 100 accounts', () => {
  for (const rows of [
    [
      ['1130', 5, 0],
      ['3110-001', 0, 4],
    ],
    [
      ['1130', 5, 5],
      ['3110-001', 0, 0],
    ],
    [
      ['1130', -5, 0],
      ['3110-001', 0, -5],
    ],
    Array.from({ length: 102 }, (_, i) => [
      String(i),
      i < 51 ? 1 : 0,
      i >= 51 ? 1 : 0,
    ]),
  ])
    assert.ok(
      parseBusinessImportRows([
        sheet('Saldos', ['cuenta', 'debe', 'haber'], ...rows),
      ]).problems.length,
    )
  const result = parseBusinessImportRows([
    sheet(
      'Saldos',
      ['cuenta', 'debe', 'haber'],
      ['1130', 0.3, null],
      ['3110-001', null, 0.1],
      ['3110-002', null, 0.2],
    ),
  ])
  assert.deepEqual(result.problems, [])
})

test('empty optional sheets are allowed but a header-only workbook does not import', () => {
  assert.ok(
    parseBusinessImportRows([products()]).problems.some(
      (p) => p.sheet === 'Archivo',
    ),
  )
  const result = parseBusinessImportRows([
    products(['001', 'Perfume', 'Marca']),
    stock(),
    { name: 'Cuentas', rows: [] },
  ])
  assert.deepEqual(result.problems, [])
  assert.equal(result.data.accounts.length, 0)
})

test('limits rows, validates product choices, business cardinality and contact emails', () => {
  const tooMany = {
    name: 'Clientes',
    rows: [['nombre'], ...Array.from({ length: 5001 }, (_, i) => [String(i)])],
  }
  assert.ok(
    parseBusinessImportRows([tooMany]).problems.some((p) =>
      p.message.includes('5000'),
    ),
  )
  assert.ok(
    parseBusinessImportRows([
      sheet(
        'Productos',
        ['sku', 'nombre', 'marca', 'unidad', 'genero'],
        ['001', 'Uno', 'Marca', 'litros', 'otro'],
      ),
    ]).problems.length,
  )
  assert.ok(
    parseBusinessImportRows([
      sheet('Clientes', ['nombre', 'correo'], ['Ana', 'correo roto']),
    ]).problems.length,
  )
  assert.ok(
    parseBusinessImportRows([
      sheet('Negocio', ['nombre'], ['Uno'], ['Dos']),
    ]).problems.some((p) => p.message.includes('sola fila')),
  )
})

test('validates data limits before preview and distinguishes supplier columns from customer pricing', () => {
  for (const row of [
    ['001', 'Perfume', 'Marca', 0, 100, null, null],
    ['001', 'Perfume', 'Marca', 1, 100000, null, null],
    ['001', 'Perfume', 'Marca', 1, 100, 1000001, null],
    ['001', 'Perfume', 'Marca', 1, 100, 0, '1234'],
  ])
    assert.ok(
      parseBusinessImportRows([
        sheet(
          'Productos',
          [
            'sku',
            'nombre',
            'marca',
            'precio_vip_usd',
            'tamano',
            'minimo',
            'codigo_barras',
          ],
          row,
        ),
      ]).problems.length,
    )
  assert.ok(
    parseBusinessImportRows([
      sheet('Clientes', ['nombre', 'telefono'], ['Ana', '+505 88881234']),
    ]).problems.some((p) => p.message.includes('telefono')),
  )
  assert.ok(
    parseBusinessImportRows([
      sheet('Proveedores', ['nombre', 'nivel'], ['Proveedor', 'vip']),
    ]).problems.some((p) => p.message.includes('desconocida')),
  )
  assert.deepEqual(
    parseBusinessImportRows([stock(['001', 1000000, 0, 999999999.123456])])
      .problems,
    [],
  )
})

test('rejects old .xls and oversized files with actionable messages before reading bytes', async () => {
  const old = await readBusinessWorkbook({ name: 'negocio.xls', size: 1 })
  assert.match(old.problems[0].message, /Guardar como.*xlsx/)
  const large = await readBusinessWorkbook({
    name: 'negocio.xlsx',
    size: 5 * 1024 * 1024 + 1,
  })
  assert.match(large.problems[0].message, /5 MB/)
  const corrupt = await readBusinessWorkbook({
    name: 'negocio.xlsx',
    size: 3,
    arrayBuffer: async () => new ArrayBuffer(3),
  })
  assert.ok(corrupt.problems.length)
})

test('template is a real XLSX with instructions and no business data examples', async () => {
  const file = businessImportTemplate()
  assert.equal(
    file.type,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const text = new TextDecoder().decode(await file.arrayBuffer())
  assert.match(text, /Instrucciones/)
  assert.match(text, /costo_unitario_nio/)
  assert.match(text, /precio_emprendedor_usd/)
  assert.match(text, /cuentas de detalle/)
  // The writer stores XML without compression, so real data examples would be visible here.
  assert.doesNotMatch(text, /SKU-001|cliente@example.com|Casa SA/)
})
