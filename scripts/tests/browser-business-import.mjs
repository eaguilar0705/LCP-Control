import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = 'output/business-import-review'
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
await mkdir(output, { recursive: true })
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks++
}

// A small independent Excel fixture exercises the reader with the compressed
// entries and shared strings written by Excel, rather than only our exporter.
const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc32 = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const chunks = [],
    central = []
  let offset = 0
  for (const [path, text] of entries) {
    const name = Buffer.from(path),
      bytes = Buffer.from(text)
    const compressed = deflateRawSync(bytes),
      crc = crc32(bytes)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    chunks.push(local, compressed)
    const record = Buffer.alloc(46 + name.length)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(bytes.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    name.copy(record, 46)
    central.push(record)
    offset += local.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(
    central.reduce((sum, part) => sum + part.length, 0),
    12,
  )
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, ...central, end])
}
function workbook(sheets) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const strings = []
  const textCell = (value) => {
    let index = strings.indexOf(String(value))
    if (index === -1) {
      index = strings.length
      strings.push(String(value))
    }
    return `<c t="s"><v>${index}</v></c>`
  }
  const worksheets = sheets.map((sheet, index) => [
    `xl/worksheets/sheet${index + 1}.xml`,
    `<worksheet xmlns="${ns}"><sheetData>${sheet.rows
      .map(
        (row, number) =>
          `<row r="${number + 1}">${row
            .map((value) =>
              value === null
                ? '<c/>'
                : typeof value === 'number'
                  ? `<c><v>${value}</v></c>`
                  : typeof value === 'object'
                    ? `<c><f>${escapeXml(value.formula)}</f><v>${value.cached ?? 0}</v></c>`
                    : textCell(value),
            )
            .join('')}</row>`,
      )
      .join('')}</sheetData></worksheet>`,
  ])
  return zip([
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    ],
    [
      '_rels/.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="shared" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('')}</sst>`,
    ],
    ...worksheets,
  ])
}

const importSheets = [
  {
    name: 'Productos',
    rows: [
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
        'EXCEL-001',
        'Perfume Ámbar & Rosas de migración',
        'Marca de migración',
        '0123456789012',
        100,
        'ml',
        'arabe',
        'unisex',
        2,
        12.5,
        11,
        10,
      ],
      [
        'EXCEL-002',
        'Perfume pendiente de conteo',
        'Marca de migración',
        null,
        50,
        'ml',
        'nicho',
        'mujer',
        0,
        8,
        null,
        null,
      ],
    ],
  },
  {
    name: 'Existencias',
    rows: [
      ['sku', 'bodega', 'tienda', 'costo_unitario_nio'],
      ['EXCEL-001', 12, 4, 123.45],
      ['EXCEL-002', 3, null, null],
    ],
  },
  // Optional sheets in a downloaded template can stay header-only.
  { name: 'Cuentas', rows: [['codigo', 'nombre', 'padre']] },
  {
    name: 'Clientes',
    rows: [
      ['nombre', 'telefono', 'correo', 'direccion', 'ruc', 'nivel'],
      [
        'Cliente migración Excel',
        '88881122',
        'cliente@example.test',
        'Managua',
        '001-EXCEL',
        'vip',
      ],
    ],
  },
]
const uploaded = workbook(importSheets)
const formula = workbook([
  {
    name: 'Existencias',
    rows: [
      ['sku', 'bodega', 'tienda', 'costo_unitario_nio'],
      ['EXCEL-001', { formula: 'SUM(2,3)', cached: 5 }, 4, 100],
    ],
  },
])
const badQuantity = workbook([
  {
    name: 'Existencias',
    rows: [
      ['sku', 'bodega', 'tienda', 'costo_unitario_nio'],
      ['EXCEL-001', 'doce', 4, 100],
    ],
  },
])
const accountFile = workbook([
  {
    name: 'Cuentas',
    rows: [
      ['codigo', 'nombre', 'padre'],
      ['1120-099', 'Banco de migración Excel', '1120'],
    ],
  },
])

async function readInBrowser(page, buffer, name = 'migracion.xlsx') {
  return page.evaluate(
    async ({ bytes, name }) => {
      const { readBusinessWorkbook } =
        await import('/src/features/administration/businessImportWorkbook.ts')
      return readBusinessWorkbook(new File([new Uint8Array(bytes)], name))
    },
    { bytes: [...buffer], name },
  )
}
async function login(page) {
  await page.goto(base + '/login')
  await page
    .getByLabel('Correo electrónico', { exact: true })
    .fill('auditoria@example.test')
  await page
    .getByLabel('Contraseña', { exact: true })
    .fill('Local-test-password!')
  await page
    .getByRole('button', { name: 'Iniciar sesión', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
}
async function navigate(page, path) {
  await page.evaluate((path) => {
    globalThis.history.pushState({}, '', path)
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
  }, path)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, params = []) =>
      (await fixture.db.query(sql, params)).rows[0]
    const healthy = async (name) => {
      equal(errors, [], name + ': navegador sin errores')
      equal(fixture.failures, [], name + ': API sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': página sin desbordamiento horizontal',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
          false,
          name + ': diálogo sin desbordamiento horizontal',
        )
    }
    try {
      // Adoption occurs before the first opening voucher. Keep the shared
      // daily-operation fixture unchanged and remove only its local opening.
      await fixture.db.exec(
        'reset role; delete from public.journal_lines; delete from public.journal_entries;',
      )
      await identity(fixture.db, admin)
      // Both kinds of administrator can use the flow; role comes from SQL.
      if (width === 390) {
        await fixture.db.exec(
          `reset role; update public.staff_members set role='admin' where user_id='${admin}';`,
        )
        await identity(fixture.db, admin)
      }
      await login(page)
      await navigate(page, '/settings')
      await page
        .getByRole('heading', { name: 'Datos del negocio', exact: true })
        .waitFor()
      const trigger = page.getByRole('button', {
        name: 'Importar desde Excel',
        exact: true,
      })
      await trigger.click()
      let dialog = page.getByRole('dialog', {
        name: 'Importar negocio desde Excel',
        exact: true,
      })
      await dialog.waitFor()
      const downloaded = page.waitForEvent('download')
      await dialog
        .getByRole('button', { name: 'Descargar plantilla Excel', exact: true })
        .click()
      const template = await downloaded
      equal(
        template.suggestedFilename(),
        'plantilla-migracion-casa-del-perfume.xlsx',
        'descarga plantilla Excel',
      )
      const templatePath = `${output}/plantilla-${width}.xlsx`
      await template.saveAs(templatePath)
      const emptyTemplate = await readInBrowser(
        page,
        await readFile(templatePath),
      )
      equal(
        emptyTemplate.problems.length,
        1,
        'plantilla vacía conserva encabezados válidos',
      )
      ok(
        emptyTemplate.problems[0].message.includes('no contiene datos'),
        'plantilla requiere datos reales',
      )

      const parsed = await readInBrowser(page, uploaded)
      equal(
        parsed.problems,
        [],
        'lee un Excel comprimido con textos compartidos',
      )
      equal(
        parsed.data.products[0].barcode,
        '0123456789012',
        'conserva ceros iniciales',
      )
      equal(
        parsed.data.products[0].name,
        'Perfume Ámbar & Rosas de migración',
        'conserva acentos y caracteres XML',
      )
      equal(
        parsed.data.stocks[1],
        { sku: 'EXCEL-002', warehouse: 3, store: null, unitCostNio: null },
        'vacío permanece pendiente, separado de cero',
      )
      const withFormula = await readInBrowser(page, formula)
      ok(
        withFormula.problems.some(
          (problem) =>
            problem.sheet === 'Existencias' &&
            problem.row === 2 &&
            problem.message.includes('fórmulas'),
        ),
        'rechaza fórmulas aunque tengan valor calculado',
      )

      // The production writer also round-trips through the real browser reader.
      const productionRoundTrip = await page.evaluate(async () => {
        const { buildWorkbook } = await import('/src/lib/xlsx.ts')
        const { readBusinessWorkbook } =
          await import('/src/features/administration/businessImportWorkbook.ts')
        const blob = buildWorkbook([
          {
            name: 'Existencias',
            columns: [
              { header: 'sku' },
              { header: 'bodega', format: 'integer' },
              { header: 'tienda', format: 'integer' },
            ],
            rows: [['EXCEL-003', 0, null]],
          },
        ])
        return readBusinessWorkbook(new File([blob], 'exportador.xlsx'))
      })
      equal(
        productionRoundTrip.problems,
        [],
        'Excel del exportador se vuelve a leer',
      )
      equal(
        productionRoundTrip.data.stocks[0].warehouse,
        0,
        'cero contado se conserva',
      )
      equal(
        productionRoundTrip.data.stocks[0].store,
        null,
        'ubicación no contada sigue pendiente',
      )

      const baseline = await one(
        'select (select count(*)::int from public.products) products,(select count(*)::int from public.customers) customers,(select count(*)::int from public.inventory_movements) movements',
      )
      await dialog
        .getByLabel('Archivo Excel (.xlsx)', { exact: true })
        .setInputFiles({
          name: 'migracion.xlsx',
          mimeType: mime,
          buffer: uploaded,
        })
      await dialog
        .getByRole('heading', {
          name: 'Datos del archivo: migracion.xlsx',
          exact: true,
        })
        .waitFor()
      await dialog
        .locator('summary')
        .filter({ hasText: /^Existencias \(/ })
        .click()
      ok(
        (
          await dialog
            .getByRole('region', {
              name: 'Vista previa de Existencias',
              exact: true,
            })
            .innerText()
        ).includes('Pendiente'),
        'vista previa distingue cantidades pendientes',
      )
      await dialog
        .getByRole('button', { name: 'Validar en el sistema', exact: true })
        .click()
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Validación completada' })
        .waitFor()
      equal(
        await one(
          'select (select count(*)::int from public.products) products,(select count(*)::int from public.customers) customers,(select count(*)::int from public.inventory_movements) movements',
        ),
        baseline,
        'la vista previa SQL no guarda catálogo, clientes ni movimientos',
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Confirmar importación', exact: true })
          .isDisabled(),
        true,
        'confirmación exige revisión explícita',
      )
      await healthy('vista previa ' + width)
      await dialog.screenshot({ path: `${output}/vista-previa-${width}.png` })
      await dialog
        .getByRole('checkbox', {
          name: 'Revisé los datos y la fecha de apertura.',
          exact: true,
        })
        .check()
      await dialog
        .getByRole('button', { name: 'Confirmar importación', exact: true })
        .click()
      await dialog
        .getByRole('heading', {
          name: 'Datos importados correctamente',
          exact: true,
        })
        .waitFor()
      equal(
        (
          await one(
            "select count(*)::int n from public.products where sku like 'EXCEL-%'",
          )
        ).n,
        2,
        'guarda ambos productos',
      )
      const first = await one(
        "select id,barcode from public.products where sku='EXCEL-001'",
      )
      equal(
        first.barcode,
        '0123456789012',
        'código de barras conservado en PostgreSQL',
      )
      equal(
        (
          await fixture.db.query(
            'select location,quantity from public.inventory_balances where product_id=$1 order by location',
            [first.id],
          )
        ).rows,
        [
          { location: 'store', quantity: 4 },
          { location: 'warehouse', quantity: 12 },
        ],
        'guarda tienda y bodega por separado',
      )
      equal(
        Number(
          (
            await one(
              'select average_cost_nio from public.product_costs where product_id=$1',
              [first.id],
            )
          ).average_cost_nio,
        ),
        123.45,
        'guarda costo contable en córdobas',
      )
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code='vip' and currency='USD'",
              [first.id],
            )
          ).amount,
        ),
        11,
        'guarda lista de precios',
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=(select id from public.products where sku='EXCEL-002') and location='store'",
          )
        ).quantity,
        null,
        'no convierte tienda vacía en cero',
      )
      equal(
        await one(
          "select price_tier,tax_id from public.customers where name='Cliente migración Excel'",
        ),
        { price_tier: 'vip', tax_id: '001-EXCEL' },
        'migra cliente para facturación',
      )
      const importedCounts = await one(
        'select (select count(*)::int from public.products) products,(select count(*)::int from public.customers) customers,(select count(*)::int from public.inventory_movements) movements',
      )
      await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .last()
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        await trigger.evaluate(
          (element) => element === globalThis.document.activeElement,
        ),
        true,
        'cerrar devuelve foco al botón importador',
      )

      // Reopening with the same file must recover the original result.
      await trigger.click()
      dialog = page.getByRole('dialog', {
        name: 'Importar negocio desde Excel',
        exact: true,
      })
      await dialog
        .getByRole('button', { name: 'Importar otro archivo', exact: true })
        .click()
      await dialog
        .getByLabel('Archivo Excel (.xlsx)', { exact: true })
        .setInputFiles({
          name: 'migracion.xlsx',
          mimeType: mime,
          buffer: uploaded,
        })
      await dialog
        .getByRole('heading', {
          name: 'Datos del archivo: migracion.xlsx',
          exact: true,
        })
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Validar en el sistema', exact: true })
        .click()
      await dialog
        .getByRole('status')
        .filter({ hasText: 'El sistema reconoce este archivo' })
        .waitFor()
      await dialog
        .getByRole('checkbox', {
          name: 'Revisé los datos y la fecha de apertura.',
          exact: true,
        })
        .check()
      await dialog
        .getByRole('button', { name: 'Confirmar carga existente', exact: true })
        .click()
      await dialog
        .getByRole('heading', {
          name: 'Este archivo ya estaba importado',
          exact: true,
        })
        .waitFor()
      equal(
        await one(
          'select (select count(*)::int from public.products) products,(select count(*)::int from public.customers) customers,(select count(*)::int from public.inventory_movements) movements',
        ),
        importedCounts,
        'reintento no duplica catálogo, clientes o conteos',
      )
      await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .last()
        .click()
      await dialog.waitFor({ state: 'hidden' })

      await trigger.click()
      await dialog
        .getByRole('button', { name: 'Importar otro archivo', exact: true })
        .click()
      await dialog
        .getByLabel('Archivo Excel (.xlsx)', { exact: true })
        .setInputFiles({
          name: 'cantidades-invalidas.xlsx',
          mimeType: mime,
          buffer: badQuantity,
        })
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Existencias, fila 2:' })
        .waitFor()
      ok(
        (await dialog.getByRole('alert').innerText()).includes(
          'bodega debe ser un número entero',
        ),
        'error indica hoja, fila y cantidad que corregir',
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Validar en el sistema', exact: true })
          .count(),
        0,
        'archivo inválido no puede enviar filas al servidor',
      )
      equal(
        await one(
          'select (select count(*)::int from public.products) products,(select count(*)::int from public.customers) customers,(select count(*)::int from public.inventory_movements) movements',
        ),
        importedCounts,
        'archivo rechazado no guarda cambios',
      )
      await healthy('errores por fila ' + width)
      await dialog.screenshot({ path: `${output}/errores-${width}.png` })

      // An account-only workbook is useful when the catalogue already exists.
      await dialog
        .getByLabel('Archivo Excel (.xlsx)', { exact: true })
        .setInputFiles({
          name: 'cuentas.xlsx',
          mimeType: mime,
          buffer: accountFile,
        })
      await dialog
        .getByRole('heading', {
          name: 'Datos del archivo: cuentas.xlsx',
          exact: true,
        })
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Validar en el sistema', exact: true })
        .click()
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Validación completada' })
        .waitFor()
      equal(
        (
          await one(
            "select count(*)::int n from public.ledger_accounts where code='1120-099'",
          )
        ).n,
        0,
        'vista previa no crea cuentas contables',
      )
      await dialog
        .getByRole('checkbox', {
          name: 'Revisé los datos y la fecha de apertura.',
          exact: true,
        })
        .check()
      await dialog
        .getByRole('button', { name: 'Confirmar importación', exact: true })
        .click()
      await dialog
        .getByRole('heading', {
          name: 'Datos importados correctamente',
          exact: true,
        })
        .waitFor()
      equal(
        await one(
          "select name,parent from public.ledger_accounts where code='1120-099'",
        ),
        { name: 'Banco de migración Excel', parent: '1120' },
        'importa cuenta bajo su cuenta mayor',
      )
      await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .last()
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await healthy('importación completa ' + width)
      await page.screenshot({
        path: `${output}/negocio-${width}.png`,
        fullPage: false,
      })

      await fixture.db.exec(
        `reset role; update public.staff_members set role='operator' where user_id='${admin}';`,
      )
      await identity(fixture.db, admin)
      await page.reload()
      await login(page)
      await navigate(page, '/settings')
      await page
        .getByText('Solo los administradores pueden configurar el negocio.', {
          exact: true,
        })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Importar desde Excel', exact: true })
          .count(),
        0,
        'operador no ve importación',
      )
      await navigate(page, '/demo/settings')
      await page
        .getByRole('heading', { name: 'Datos del negocio', exact: true })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Importar desde Excel', exact: true })
          .count(),
        0,
        'demostración no permite importar',
      )
      await healthy('permisos ' + width)
      console.log(
        `PASS importación Excel ${width}px: plantilla, Excel comprimido, vista previa, catálogo, existencias por ubicación, costos, clientes, cuentas, reintentos y permisos`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      console.error(
        'URL',
        page.url(),
        'API',
        fixture.failures,
        'Navegador',
        errors,
        'UI',
        (await page.locator('body').innerText()).slice(-6000),
      )
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`OK: ${checks} comprobaciones de importación Excel del negocio`)
