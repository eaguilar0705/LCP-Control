import type {
  BusinessImportData,
  ImportContact,
} from '@lcp/contracts/businessImport'
import { buildWorkbook, type Sheet } from '../../lib/xlsx'

export interface BusinessImportProblem {
  sheet: string
  row: number
  message: string
}
export type BusinessImportCell = string | number | null | { error: string }
export interface BusinessImportSheet {
  name: string
  rows: BusinessImportCell[][]
}
export interface BusinessImportWorkbook {
  data: BusinessImportData
  problems: BusinessImportProblem[]
}

const MAX_FILE = 5 * 1024 * 1024
const MAX_XML = 12 * 1024 * 1024
const MAX_EXPANDED = 32 * 1024 * 1024
const MAX_ROWS = 5000
const MAX_COLUMNS = 32
const MAX_AMOUNT = 100000000
const columns = {
  Productos: [
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
  Existencias: ['sku', 'bodega', 'tienda', 'costo_unitario_nio'],
  Cuentas: ['codigo', 'nombre', 'padre'],
  Saldos: ['cuenta', 'debe', 'haber'],
  Clientes: ['nombre', 'telefono', 'correo', 'direccion', 'ruc', 'nivel'],
  Proveedores: ['nombre', 'telefono', 'correo', 'direccion', 'ruc'],
  Negocio: [
    'nombre',
    'razon_social',
    'ruc',
    'direccion',
    'telefono',
    'correo',
    'sucursal',
    'datos_facturacion',
  ],
} as const
type SheetName = keyof typeof columns
const requiredHeaders: Record<SheetName, readonly string[]> = {
  Productos: ['sku', 'nombre', 'marca'],
  Existencias: ['sku', 'bodega', 'tienda'],
  Cuentas: ['codigo', 'nombre'],
  Saldos: ['cuenta', 'debe', 'haber'],
  Clientes: ['nombre'],
  Proveedores: ['nombre'],
  Negocio: ['nombre', 'razon_social', 'ruc', 'direccion', 'telefono'],
}
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
const isEmpty = (value: BusinessImportCell | undefined) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && !value.trim())
const emptyData = (): BusinessImportData => ({
  products: [],
  stocks: [],
  accounts: [],
  openingBalances: [],
  customers: [],
  suppliers: [],
  business: null,
})

/** Pure mapping stage, also used to verify workbooks without browser APIs. */
export function parseBusinessImportRows(
  sheets: BusinessImportSheet[],
): BusinessImportWorkbook {
  const data = emptyData()
  const problems: BusinessImportProblem[] = []
  const seenSheets = new Set<string>()
  const keys = new Map<string, Set<string>>()
  let meaningful = false
  const problem = (sheet: string, row: number, message: string) => {
    if (problems.length < 100) problems.push({ sheet, row, message })
  }
  for (const sheet of sheets) {
    const key = normalize(sheet.name)
    if (seenSheets.has(key)) {
      problem(sheet.name, 1, 'La hoja está duplicada.')
      continue
    }
    seenSheets.add(key)
    if (key === 'instrucciones') continue
    const name = (Object.keys(columns) as SheetName[]).find(
      (item) => normalize(item) === key,
    )
    if (!name) {
      problem(
        sheet.name,
        1,
        'Hoja desconocida. Usa los nombres de la plantilla; no se descartan hojas con datos.',
      )
      continue
    }
    const rows = sheet.rows
    if (rows.length > MAX_ROWS + 1) {
      problem(name, 1, `La hoja admite hasta ${MAX_ROWS} filas de datos.`)
      continue
    }
    if (rows.every((row) => row.every(isEmpty))) continue
    const header = rows[0] ?? []
    const indexes = new Map<string, number>()
    for (const [index, cell] of header.entries()) {
      if (isEmpty(cell)) continue
      if (typeof cell !== 'string') {
        problem(
          name,
          1,
          `El encabezado de la columna ${index + 1} debe ser texto, sin fórmulas.`,
        )
        continue
      }
      const label = normalize(cell)
      if (indexes.has(label)) problem(name, 1, `Columna duplicada: ${cell}.`)
      else if (!(columns[name] as readonly string[]).includes(label))
        problem(name, 1, `Columna desconocida: ${cell}.`)
      else indexes.set(label, index)
    }
    for (const label of requiredHeaders[name]) {
      if (!indexes.has(label)) problem(name, 1, `Falta la columna ${label}.`)
    }
    for (let index = 1; index < rows.length; index++) {
      const values = rows[index]
      if (values.every(isEmpty)) continue
      const row = index + 1
      meaningful = true
      for (const [column, value] of values.entries()) {
        if (isEmpty(value)) continue
        if (typeof value === 'object' && value !== null)
          problem(name, row, value.error)
        if (
          !header[column] ||
          !indexes.has(normalize(String(header[column])))
        ) {
          problem(
            name,
            row,
            `Hay datos en la columna ${column + 1} sin un encabezado reconocido.`,
          )
        }
      }
      const cell = (field: string): BusinessImportCell | undefined => {
        const at = indexes.get(field)
        return at === undefined ? undefined : values[at]
      }
      const text = (field: string, required = false, max = 500): string => {
        const value = cell(field)
        const result =
          typeof value === 'string' || typeof value === 'number'
            ? String(value).trim()
            : ''
        if (required && !result) problem(name, row, `${field} es obligatorio.`)
        if (result.length > max)
          problem(name, row, `${field} supera ${max} caracteres.`)
        return result
      }
      const number = (
        field: string,
        blank: number | null,
        integer = false,
        precision = 2,
        max = MAX_AMOUNT,
        positive = false,
      ): number | null => {
        const value = cell(field)
        if (isEmpty(value)) return blank
        // Ambiguous separators, currency symbols, scientific notation in text and
        // formulas must be corrected in Excel instead of guessed silently.
        const parsed =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
              ? Number(value.trim())
              : NaN
        if (
          !Number.isFinite(parsed) ||
          parsed < 0 ||
          parsed > max ||
          (positive && parsed === 0) ||
          (integer && !Number.isInteger(parsed))
        ) {
          problem(
            name,
            row,
            `${field} debe ser un número ${integer ? 'entero ' : ''}${positive ? 'mayor que 0 y hasta' : 'entre 0 y'} ${max}, con punto decimal y sin separadores de miles.`,
          )
          return blank
        }
        if (!integer && parsed !== Number(parsed.toFixed(precision))) {
          problem(name, row, `${field} admite hasta ${precision} decimales.`)
        }
        return parsed
      }
      const unique = (field: string, value: string) => {
        const set = keys.get(name) ?? new Set<string>()
        keys.set(name, set)
        const normalized = value.toLowerCase()
        if (normalized && set.has(normalized))
          problem(name, row, `${field} duplicado: ${value}.`)
        set.add(normalized)
      }
      const choice = <T extends string>(
        field: string,
        options: Record<string, T>,
        fallback: T | null,
      ): T | null => {
        const value = normalize(text(field))
        if (!value) return fallback
        if (Object.hasOwn(options, value)) return options[value]
        problem(
          name,
          row,
          `${field} no válido. Usa: ${Object.keys(options).join(', ')}.`,
        )
        return fallback
      }
      switch (name) {
        case 'Productos': {
          const sku = text('sku', true, 100)
          unique('sku', sku)
          const size = number('tamano', null, false, 3, 99999, true)
          const barcode = text('codigo_barras', false, 14) || null
          if (barcode && !/^[0-9]{8}$|^[0-9]{12,14}$/.test(barcode))
            problem(
              name,
              row,
              'codigo_barras debe tener 8, 12, 13 o 14 dígitos, o quedar vacío.',
            )
          const price = (field: string) =>
            number(field, null, false, 2, 10000000, true)
          data.products.push({
            sku,
            name: text('nombre', true, 200),
            brand: text('marca', true, 100),
            barcode,
            size,
            unit: choice('unidad', { ml: 'ml', oz: 'oz' }, 'ml')!,
            category: choice(
              'categoria',
              {
                arabian: 'arabian',
                arabe: 'arabian',
                designer: 'designer',
                disenador: 'designer',
                niche: 'niche',
                nicho: 'niche',
              },
              null,
            ),
            gender: choice(
              'genero',
              {
                male: 'male',
                masculino: 'male',
                hombre: 'male',
                female: 'female',
                femenino: 'female',
                mujer: 'female',
                unisex: 'unisex',
              },
              null,
            ),
            minimumStock: number('minimo', 0, true, 0, 1000000)!,
            pricesUSD: {
              emprendedor: price('precio_emprendedor_usd'),
              vip: price('precio_vip_usd'),
              premium: price('precio_premium_usd'),
            },
          })
          break
        }
        case 'Existencias': {
          const sku = text('sku', true, 100)
          unique('sku', sku)
          const warehouse = number('bodega', null, true, 0, 1000000)
          const store = number('tienda', null, true, 0, 1000000)
          const unitCostNio = number(
            'costo_unitario_nio',
            null,
            false,
            6,
            1000000000,
          )
          if (warehouse === null && store === null && unitCostNio === null)
            problem(
              name,
              row,
              'Indica una existencia o un costo. Una celda vacía significa pendiente, no cero.',
            )
          data.stocks.push({ sku, warehouse, store, unitCostNio })
          break
        }
        case 'Cuentas': {
          const code = text('codigo', true, 40)
          unique('codigo', code)
          if (!/^[1-6][0-9]{3}(-[0-9]{3}){0,3}$/.test(code))
            problem(
              name,
              row,
              'codigo de cuenta inválido. Usa el formato 1120 o 1120-001, con hasta tres grupos de tres dígitos.',
            )
          data.accounts.push({
            code,
            name: text('nombre', true, 160),
            parent: text('padre', false, 40) || null,
          })
          break
        }
        case 'Saldos': {
          const account = text('cuenta', true, 40)
          unique('cuenta', account)
          const debit = number('debe', 0)!
          const credit = number('haber', 0)!
          if (!((debit > 0 && credit === 0) || (credit > 0 && debit === 0)))
            problem(
              name,
              row,
              'Cada saldo debe tener un importe positivo solo en debe o en haber.',
            )
          data.openingBalances.push({ account, debit, credit })
          if (data.openingBalances.length === 101)
            problem(name, row, 'Saldos admite hasta 100 filas.')
          break
        }
        case 'Clientes':
        case 'Proveedores': {
          const contact: ImportContact = {
            name: text('nombre', true, 160),
            phone: text('telefono', false, 60) || null,
            email: text('correo', false, 254),
            address: text('direccion', false, 600),
            taxId: text('ruc', false, 80),
            priceTier: choice(
              'nivel',
              { emprendedor: 'emprendedor', vip: 'vip', premium: 'premium' },
              'emprendedor',
            )!,
          }
          unique('nombre', contact.name)
          if (
            name === 'Clientes' &&
            contact.phone &&
            !/^[1-9][0-9]{7,14}$/.test(contact.phone)
          )
            problem(
              name,
              row,
              'telefono debe contener entre 8 y 15 dígitos, sin espacios, símbolos ni cero inicial.',
            )
          if (
            contact.email &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)
          )
            problem(name, row, 'correo no válido.')
          ;(name === 'Clientes' ? data.customers : data.suppliers).push(contact)
          break
        }
        case 'Negocio': {
          if (data.business) problem(name, row, 'Negocio admite una sola fila.')
          else
            data.business = {
              name: text('nombre', true, 160),
              legalName: text('razon_social', true, 160),
              taxId: text('ruc', true, 40),
              address: text('direccion', true, 600),
              phone: text('telefono', true, 60),
              email: text('correo', false, 160),
              branch: text('sucursal', false, 100),
              billingDetails: text('datos_facturacion', false, 240),
            }
          if (
            data.business?.email &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.business.email)
          )
            problem(name, row, 'correo no válido.')
          break
        }
      }
    }
  }
  if (!meaningful)
    problem(
      'Archivo',
      1,
      'El libro no contiene datos para importar. Completa las hojas de la plantilla.',
    )
  if (data.openingBalances.length) {
    const debit = Math.round(
      data.openingBalances.reduce(
        (sum, line) => sum + Math.round(line.debit * 100),
        0,
      ),
    )
    const credit = Math.round(
      data.openingBalances.reduce(
        (sum, line) => sum + Math.round(line.credit * 100),
        0,
      ),
    )
    if (debit !== credit)
      problem('Saldos', 1, 'Los totales de debe y haber deben ser iguales.')
    if (data.openingBalances.length < 2)
      problem('Saldos', 1, 'El asiento inicial requiere al menos dos cuentas.')
  }
  return { data, problems }
}

interface ZipEntry {
  method: number
  compressed: number
  size: number
  offset: number
  crc: number
}
const fail = (message: string): never => {
  throw new Error(message)
}
const decoder = new TextDecoder('utf-8', { fatal: true })
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Central directory sizes are checked before inflation and during streaming. */
function zipReader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break
  }
  if (end < 0 || bytes.length < 22 || view.getUint32(end, true) !== 0x06054b50)
    fail('El archivo no es un libro .xlsx válido o está incompleto.')
  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  let at = view.getUint32(end + 16, true)
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    count !== view.getUint16(end + 8, true) ||
    count > 128 ||
    at + centralSize !== end
  )
    fail('Estructura ZIP no admitida o demasiado grande.')
  const entries = new Map<string, ZipEntry>()
  let expanded = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      fail('Directorio ZIP dañado.')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const recordLength =
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    if (
      at + recordLength > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > MAX_XML ||
      (expanded += size) > MAX_EXPANDED ||
      offset + 30 > at
    )
      fail(
        'El libro está cifrado, tiene una compresión no admitida o excede los límites de tamaño.',
      )
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    if (
      entries.has(name) ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      name.includes('\\')
    )
      fail('El libro contiene rutas internas duplicadas o no válidas.')
    entries.set(name, {
      method,
      compressed,
      size,
      offset,
      crc: view.getUint32(at + 16, true),
    })
    at += recordLength
  }
  if (at !== end) fail('Directorio ZIP no válido.')
  const cache = new Map<string, string>()
  return {
    has: (name: string) => entries.has(name),
    async read(name: string): Promise<string> {
      const cached = cache.get(name)
      if (cached !== undefined) return cached
      const entry =
        entries.get(name) ?? fail(`Falta el archivo interno ${name}.`)
      const local = entry.offset
      if (
        view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 8, true) !== entry.method ||
        view.getUint16(local + 6, true) & 1
      )
        fail('Entrada ZIP dañada.')
      const nameLength = view.getUint16(local + 26, true)
      const start = local + 30 + nameLength + view.getUint16(local + 28, true)
      if (
        start + entry.compressed > view.getUint32(end + 16, true) ||
        decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !==
          name
      )
        fail('Entrada ZIP truncada o incorrecta.')
      let result: Uint8Array = bytes.slice(start, start + entry.compressed)
      if (entry.method === 8) {
        let stream: DecompressionStream
        try {
          stream = new DecompressionStream('deflate-raw')
        } catch {
          fail(
            'Este navegador no permite leer archivos Excel comprimidos. Actualiza el navegador e inténtalo de nuevo.',
          )
        }
        const reader = new Blob([result as BlobPart])
          .stream()
          .pipeThrough(stream!)
          .getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        while (true) {
          const next = await reader.read()
          if (next.done) break
          length += next.value.length
          if (length > entry.size || length > MAX_XML) {
            await reader.cancel()
            fail('El contenido descomprimido excede el límite permitido.')
          }
          chunks.push(next.value)
        }
        result = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.length
        }
      }
      if (result.length !== entry.size || crc32(result) !== entry.crc)
        fail('El contenido del libro está dañado. Vuelve a guardarlo en Excel.')
      const value = decoder.decode(result)
      cache.set(name, value)
      return value
    },
  }
}

function xml(source: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    fail('El libro contiene declaraciones XML no admitidas.')
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length)
    fail('El libro contiene XML dañado.')
  return document
}
const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name))
const content = (node: Element, name: string) =>
  elements(node, name)[0]?.textContent ?? ''
function zipPath(base: string, target: string): string {
  if (!target || /[\\?#]/.test(target) || /^[a-z]+:/i.test(target))
    fail('El libro contiene una referencia externa o una ruta no admitida.')
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) fail('Ruta interna no válida.')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}
function readWorksheet(
  document: Document,
  shared: string[],
): BusinessImportCell[][] {
  if (elements(document, 'mergeCell').length)
    fail('Las hojas de datos no deben contener celdas combinadas.')
  const rows: BusinessImportCell[][] = []
  const occupied = new Set<string>()
  let previous = 0
  for (const node of elements(document, 'row')) {
    const rowNumber = node.hasAttribute('r')
      ? Number(node.getAttribute('r'))
      : previous + 1
    if (
      !Number.isInteger(rowNumber) ||
      rowNumber < 1 ||
      rowNumber > 1048576 ||
      rowNumber <= previous
    )
      fail('La hoja tiene referencias de fila no válidas.')
    previous = rowNumber
    const row: BusinessImportCell[] = []
    let nextColumn = 0
    for (const cell of elements(node, 'c')) {
      const reference = cell.getAttribute('r')
      let column = nextColumn
      if (reference) {
        const match =
          /^([A-Z]+)([1-9]\d*)$/.exec(reference) ??
          fail('Referencia de celda no válida.')
        if (Number(match[2]) !== rowNumber || occupied.has(reference))
          fail('Referencia de celda duplicada o incorrecta.')
        occupied.add(reference)
        column = 0
        for (const character of match[1])
          column = column * 26 + character.charCodeAt(0) - 64
        column--
      }
      if (column < nextColumn) fail('La hoja tiene celdas fuera de orden.')
      nextColumn = column + 1
      const type = cell.getAttribute('t') ?? 'n'
      const value = content(cell, 'v')
      let parsed: BusinessImportCell = null
      if (elements(cell, 'f').length)
        parsed = {
          error:
            'No se admiten fórmulas. Pega sus resultados como valores antes de importar.',
        }
      else if (type === 'inlineStr')
        parsed = elements(cell, 't')
          .filter((part) => part.parentElement?.localName !== 'rPh')
          .map((part) => part.textContent ?? '')
          .join('')
      else if (type === 's') {
        const position = /^\d+$/.test(value) ? Number(value) : -1
        parsed = shared[position] ?? {
          error: 'Referencia de texto compartido no válida.',
        }
      } else if (type === 'n' && value !== '')
        parsed = Number.isFinite(Number(value))
          ? Number(value)
          : { error: 'Valor numérico no válido.' }
      else if (type === 'str') parsed = value
      else if (value || !['n', 'str'].includes(type))
        parsed = {
          error:
            'Tipo de celda no admitido. Usa texto o números, sin errores ni fórmulas.',
        }
      // Excel often persists styles for otherwise empty far-away cells/rows.
      // They are not data and must not allocate a million sparse array slots.
      if (isEmpty(parsed)) continue
      if (column >= MAX_COLUMNS || rowNumber > MAX_ROWS + 1)
        fail(
          `La hoja excede ${MAX_ROWS} filas de datos o tiene demasiadas columnas con datos.`,
        )
      row[column] = parsed
    }
    if (row.length) rows[rowNumber - 1] = row
  }
  return Array.from({ length: rows.length }, (_, index) => rows[index] ?? [])
}

export async function readBusinessWorkbook(
  file: File,
): Promise<BusinessImportWorkbook> {
  try {
    if (/\.xls$/i.test(file.name))
      fail(
        'El formato .xls no es compatible. Abre el archivo en Excel y elige Guardar como: Libro de Excel (.xlsx).',
      )
    if (!/\.xlsx$/i.test(file.name)) fail('Selecciona un libro de Excel .xlsx.')
    if (!file.size || file.size > MAX_FILE)
      fail('El archivo debe contener datos y no superar 5 MB.')
    const zip = zipReader(new Uint8Array(await file.arrayBuffer()))
    const root = xml(await zip.read('_rels/.rels'))
    const main =
      elements(root, 'Relationship').find((entry) =>
        entry.getAttribute('Type')?.endsWith('/officeDocument'),
      ) ?? fail('No se encontró un libro de Excel.')
    if (main.getAttribute('TargetMode') === 'External')
      fail('El libro no puede usar referencias externas.')
    const workbookPath = zipPath('', main.getAttribute('Target') ?? '')
    const workbook = xml(await zip.read(workbookPath))
    const directory = workbookPath.split('/').slice(0, -1).join('/')
    const relationshipsPath = `${directory ? directory + '/' : ''}_rels/${workbookPath.split('/').at(-1)}.rels`
    const relationships = elements(
      xml(await zip.read(relationshipsPath)),
      'Relationship',
    )
    const relationshipMap = new Map<string, Element>()
    for (const entry of relationships) {
      const id = entry.getAttribute('Id') ?? ''
      if (!id || relationshipMap.has(id))
        fail('El libro contiene relaciones duplicadas o incorrectas.')
      relationshipMap.set(id, entry)
    }
    const strings = relationships.find((entry) =>
      entry.getAttribute('Type')?.endsWith('/sharedStrings'),
    )
    let shared: string[] = []
    if (strings) {
      if (strings.getAttribute('TargetMode') === 'External')
        fail('Los textos del libro deben estar incluidos en el archivo.')
      shared = elements(
        xml(
          await zip.read(
            zipPath(workbookPath, strings.getAttribute('Target') ?? ''),
          ),
        ),
        'si',
      ).map((item) =>
        elements(item, 't')
          .filter((part) => part.parentElement?.localName !== 'rPh')
          .map((part) => part.textContent ?? '')
          .join(''),
      )
    }
    const sheets: BusinessImportSheet[] = []
    for (const sheet of elements(workbook, 'sheet')) {
      const name = sheet.getAttribute('name') ?? ''
      const id =
        sheet.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        ) ??
        sheet.getAttribute('r:id') ??
        ''
      const entry =
        relationshipMap.get(id) ?? fail('No se encontró una hoja del libro.')
      if (
        entry.getAttribute('TargetMode') === 'External' ||
        !entry.getAttribute('Type')?.endsWith('/worksheet')
      )
        fail('El libro contiene una hoja externa o de un tipo no admitido.')
      sheets.push({
        name,
        rows:
          normalize(name) === 'instrucciones'
            ? []
            : readWorksheet(
                xml(
                  await zip.read(
                    zipPath(workbookPath, entry.getAttribute('Target') ?? ''),
                  ),
                ),
                shared,
              ),
      })
    }
    return parseBusinessImportRows(sheets)
  } catch (error) {
    return {
      data: emptyData(),
      problems: [
        {
          sheet: 'Archivo',
          row: 1,
          message:
            error instanceof Error
              ? error.message
              : 'No se pudo leer el libro. Guarda una copia como .xlsx e inténtalo de nuevo.',
        },
      ],
    }
  }
}

export function businessImportTemplate(): Blob {
  const sheets: Sheet[] = [
    {
      name: 'Instrucciones',
      columns: [
        { header: 'Guía de migración — La Casa del Perfume', width: 120 },
      ],
      rows: [
        [
          'Copia tus datos a las hojas de esta plantilla y guarda como .xlsx. No cambies sus encabezados ni uses celdas combinadas. Las hojas opcionales pueden quedar vacías o eliminarse.',
        ],
        [
          'Usa Pegado especial → Valores para eliminar fórmulas. Se rechazan fórmulas, columnas/hojas desconocidas y registros duplicados para evitar pérdidas de datos.',
        ],
        [
          'Productos: una fila por SKU. sku, nombre y marca son obligatorios. Conserva SKU, códigos de cuenta, RUC, teléfonos y códigos de barras como texto para no perder ceros iniciales.',
        ],
        [
          'Productos: unidad = ml u oz (vacío = ml); categoria = arabe, disenador o nicho; genero = hombre, mujer o unisex. minimo es entero; precios en USD y con hasta 2 decimales.',
        ],
        [
          'Existencias: una fila por SKU; bodega y tienda son cantidades enteras separadas de hasta 1.000.000. 0 significa cero verificado; vacío significa pendiente. Incluye al menos una ubicación o un costo por fila.',
        ],
        [
          'Existencias: costo_unitario_nio es el costo promedio por unidad en córdobas, hasta 6 decimales. Déjalo vacío si se desconoce; no se inventarán costos.',
        ],
        [
          'El costo inicial requiere conteos conocidos en ambas ubicaciones y existencias totales positivas. Si los conteos ya están en el sistema puedes importar solo el costo. Tras registrar la apertura contable usa los ajustes del sistema.',
        ],
        [
          'Cuentas: agrega tus cuentas nuevas con codigo, nombre y padre obligatorio del catálogo del sistema. Puedes omitir las cuentas ya existentes y referenciarlas directamente en Saldos. Si las incluyes, codigo, nombre y padre deben coincidir exactamente con el catálogo.',
        ],
        [
          'Códigos habituales: 1130 Inventario; 1110-001 Caja NIO; 1120-001 BAC NIO; 1140 Clientes; 2111 Proveedores; 3110-001 Capital. Verifica el catálogo y usa cuentas de detalle para saldos.',
        ],
        [
          'Saldos: una fila por cuenta de detalle; importes de apertura en NIO, hasta 2 decimales; cada fila solo tiene debe o haber positivo. Debe total = haber total. Máximo 100 cuentas.',
        ],
        [
          'El asiento de apertura se registra en NIO; las cuentas de caja/banco exclusivas de USD no admiten este asiento. Revisa con contabilidad las cuentas y contrapartidas antes de importar.',
        ],
        [
          'Si cargas costos de inventario y saldos iniciales, incluye la cuenta de inventario 1130 por el valor total del inventario conocido. Revisa el asiento de apertura antes de confirmar.',
        ],
        [
          'Clientes/Proveedores: una fila por nombre único. La columna nivel solo existe en Clientes: emprendedor, vip o premium (vacío = emprendedor). Teléfonos de clientes: 8 a 15 dígitos, sin espacios, signos ni cero inicial. Los demás campos son opcionales.',
        ],
        [
          'Negocio: una sola fila. Nombre comercial, razón social, RUC, dirección y teléfono son obligatorios. Correo, sucursal y datos de facturación son opcionales; los campos vacíos se enviarán vacíos.',
        ],
        [
          'Límites: archivo de 5 MB; 5.000 filas por hoja; 100 saldos. La vista previa valida los registros antes de guardar. La importación requiere administrador.',
        ],
        [
          'No se importan facturas históricas: esta plantilla migra catálogo, existencias por ubicación, catálogo contable, saldos iniciales, contactos y configuración del negocio.',
        ],
        [
          'Las hojas de datos no incluyen ejemplos. Completa solamente los datos reales que deseas migrar.',
        ],
      ],
    },
    ...(Object.keys(columns) as SheetName[]).map((name): Sheet => ({
      name,
      columns: columns[name].map((header) => ({
        header,
        width: 25,
        format: 'text',
      })),
      rows: [],
    })),
  ]
  return buildWorkbook(sheets)
}
