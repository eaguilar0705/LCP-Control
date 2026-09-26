/**
 * Lector mínimo de hojas de cálculo: CSV (o texto separado por tabuladores) y
 * libros de Excel (.xlsx), sin dependencias.
 *
 * Un .xlsx es un ZIP con varios XML dentro. Excel comprime cada parte con
 * DEFLATE, que el navegador ya sabe descomprimir (`DecompressionStream`), y el
 * XML lo lee `DOMParser`. Se lee sólo la primera hoja visible, con las celdas
 * como las ve quien abre el archivo: los números como números, el texto como
 * texto y un número con formato de porcentaje como «20%», no como 0.2.
 *
 * Todo ocurre en el navegador: el archivo no se sube a ninguna parte.
 */

export type SheetCell = string | number | boolean | null
/** Filas de la hoja; la posición `i` es la fila `i + 1` que se ve en Excel. */
export type SheetRows = SheetCell[][]

export class SpreadsheetError extends Error {}

const MAX_FILE_BYTES = 10 * 1024 * 1024
// Un XML de hoja con decenas de miles de filas pesa unos pocos MB. El tope
// evita que un archivo diminuto que se expande a gigas cuelgue la pestaña.
const MAX_PART_BYTES = 60 * 1024 * 1024
const MAX_ROWS = 20000
const MAX_COLUMNS = 200

const unreadable = () =>
  new SpreadsheetError(
    'No pudimos leer el archivo. Guárdalo desde Excel como «Libro de Excel (.xlsx)» o como CSV y vuelve a cargarlo.',
  )

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function')
    return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(unreadable())
    reader.readAsArrayBuffer(blob)
  })
}

export async function readSpreadsheet(file: Blob): Promise<SheetRows> {
  if (file.size === 0) throw new SpreadsheetError('El archivo está vacío.')
  if (file.size > MAX_FILE_BYTES)
    throw new SpreadsheetError(
      'El archivo pesa más de 10 MB. Deja sólo la hoja con los precios y vuelve a cargarlo.',
    )
  const bytes = await blobBytes(file)
  // PK\3\4: ZIP, es decir .xlsx (o .ods, que se rechaza más adelante).
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 3 &&
    bytes[3] === 4
  )
    return readWorkbook(bytes)
  // D0 CF 11 E0: el formato binario de Excel 97-2003 (.xls).
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  )
    throw new SpreadsheetError(
      'Es un archivo de Excel antiguo (.xls). Ábrelo en Excel y guárdalo como «Libro de Excel (.xlsx)» o como CSV.',
    )
  return parseCsv(decodeText(bytes))
}

// --- CSV ---------------------------------------------------------------------

/**
 * Excel guarda los CSV en UTF-8 sólo si se elige «CSV UTF-8»; el «CSV» de
 * siempre sale en Windows-1252 y el «Texto Unicode», en UTF-16. Las tildes y la
 * «ñ» tienen que llegar bien en los tres casos.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

const DELIMITERS = [';', ',', '\t'] as const

/**
 * El separador más frecuente fuera de comillas en los primeros registros (un
 * campo entre comillas puede ocupar varias líneas).
 */
function guessDelimiter(body: string): string {
  const counts = new Map<string, number>()
  let quoted = false
  let records = 0
  for (let index = 0; index < body.length && index < 64 * 1024; index++) {
    const character = body[index]
    if (character === '"') quoted = !quoted
    else if (!quoted && character === '\n') {
      // El primer registro con separadores decide: suele ser el encabezado.
      if (counts.size || ++records >= 5) break
    } else if (!quoted && (DELIMITERS as readonly string[]).includes(character))
      counts.set(character, (counts.get(character) ?? 0) + 1)
  }
  let best = ','
  let most = 0
  for (const candidate of DELIMITERS) {
    const count = counts.get(candidate) ?? 0
    if (count > most) {
      most = count
      best = candidate
    }
  }
  return best
}

/**
 * Lee un CSV con comillas a la manera de Excel (`""` es una comilla dentro de
 * un campo, y un campo entre comillas puede tener saltos de línea). El
 * separador se deduce del encabezado: `;` en Excel en español, `,` en inglés o
 * tabulador si se copió de la hoja. Una primera línea `sep=;` lo fija.
 */
export function parseCsv(text: string): SheetRows {
  let body = text.replace(/^\uFEFF/, '')
  let delimiter: string | undefined
  const hint = /^sep=(.)\r?\n/i.exec(body)
  if (hint) {
    delimiter = hint[1]
    body = body.slice(hint[0].length)
  }
  delimiter ??= guessDelimiter(body)
  const rows: SheetRows = []
  let row: SheetCell[] = []
  let field = ''
  let quoted = false
  let index = 0
  const pushField = () => {
    if (row.length < MAX_COLUMNS) row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (rows.length >= MAX_ROWS) throw tooManyRows()
    rows.push(row)
    row = []
  }
  while (index < body.length) {
    const character = body[index]
    if (quoted) {
      if (character === '"') {
        if (body[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += character
    } else if (character === '"' && field === '') quoted = true
    else if (character === delimiter) pushField()
    else if (character === '\n') pushRow()
    else if (character === '\r') {
      if (body[index + 1] !== '\n') pushRow()
    } else field += character
    index++
  }
  if (field !== '' || row.length) pushRow()
  return rows
}

const tooManyRows = () =>
  new SpreadsheetError(
    `La hoja tiene más de ${MAX_ROWS.toLocaleString('es-NI')} filas. Deja sólo los perfumes y vuelve a cargarla.`,
  )

// --- ZIP ---------------------------------------------------------------------

interface ZipEntry {
  method: number
  compressedSize: number
  size: number
  offset: number
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (
    let position = bytes.length - 22;
    position >= Math.max(0, bytes.length - 22 - 0xffff);
    position--
  ) {
    if (view.getUint32(position, true) === 0x06054b50) {
      end = position
      break
    }
  }
  if (end < 0) throw unreadable()
  const count = view.getUint16(end + 10, true)
  let position = view.getUint32(end + 16, true)
  if (count === 0xffff || position === 0xffffffff)
    throw new SpreadsheetError(
      'El archivo es demasiado grande. Deja sólo la hoja con los precios y vuelve a cargarlo.',
    )
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let entry = 0; entry < count; entry++) {
    if (
      position + 46 > bytes.length ||
      view.getUint32(position, true) !== 0x02014b50
    )
      throw unreadable()
    const flags = view.getUint16(position + 8, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const name = decoder.decode(
      bytes.subarray(position + 46, position + 46 + nameLength),
    )
    if (flags & 1)
      throw new SpreadsheetError(
        'El archivo está protegido con contraseña. Quítale la contraseña en Excel y vuelve a cargarlo.',
      )
    entries.set(name, {
      method: view.getUint16(position + 10, true),
      compressedSize: view.getUint32(position + 20, true),
      size: view.getUint32(position + 24, true),
      offset: view.getUint32(position + 42, true),
    })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new SpreadsheetError(
      'Este navegador no puede abrir libros de Excel. Actualízalo o guarda la hoja como CSV.',
    )
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  const reader = source
    .pipeThrough(
      new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    )
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_PART_BYTES) {
        await reader.cancel()
        throw new SpreadsheetError(
          'El archivo es demasiado grande. Deja sólo la hoja con los precios y vuelve a cargarlo.',
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error
    throw unreadable()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

async function entryText(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  name: string,
): Promise<string | null> {
  const entry = entries.get(name)
  if (!entry) return null
  if (entry.size > MAX_PART_BYTES)
    throw new SpreadsheetError(
      'El archivo es demasiado grande. Deja sólo la hoja con los precios y vuelve a cargarlo.',
    )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    entry.offset + 30 > bytes.length ||
    view.getUint32(entry.offset, true) !== 0x04034b50
  )
    throw unreadable()
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (data.length !== entry.compressedSize) throw unreadable()
  let content: Uint8Array
  if (entry.method === 0) content = data
  else if (entry.method === 8) content = await inflate(data)
  else throw unreadable()
  return new TextDecoder().decode(content)
}

// --- XLSX --------------------------------------------------------------------

function parseXml(text: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw unreadable()
  return document
}
/** Elementos por nombre local, sin importar el espacio de nombres. */
function elements(parent: Document | Element, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', name))
}
function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === name)
}
/** Texto de una cadena con formato, sin la guía fonética (`rPh`). */
function richText(element: Element): string {
  return elements(element, 't')
    .filter((text) => text.parentElement?.localName !== 'rPh')
    .map((text) => text.textContent ?? '')
    .join('')
}
/** «B12» → 1 (columnas desde cero). */
function columnIndex(reference: string): number {
  let index = 0
  for (const character of reference) {
    const code = character.charCodeAt(0)
    if (code < 65 || code > 90) break
    index = index * 26 + (code - 64)
  }
  return index - 1
}
/**
 * Índices de estilo cuyo formato de número es un porcentaje. Cuenta la sección
 * de los positivos: un «%» entre comillas o escapado es sólo un letrero y no
 * multiplica por cien.
 */
function percentStyles(styles: Document | null): Set<number> {
  const result = new Set<number>()
  if (!styles) return result
  const percentFormats = new Set([9, 10])
  for (const format of elements(styles, 'numFmt')) {
    const code = (format.getAttribute('formatCode') ?? '')
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '')
      .split(';')[0]
    if (code.includes('%'))
      percentFormats.add(Number(format.getAttribute('numFmtId')))
  }
  const cellXfs = elements(styles, 'cellXfs')[0]
  if (!cellXfs) return result
  children(cellXfs, 'xf').forEach((xf, index) => {
    if (percentFormats.has(Number(xf.getAttribute('numFmtId') ?? 0)))
      result.add(index)
  })
  return result
}
/** 0.2 con formato de porcentaje se lee como la persona lo ve: «20%». */
function asPercent(value: number): string {
  return `${Math.round(value * 100 * 1e6) / 1e6}%`
}
function resolveTarget(target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

async function readWorkbook(bytes: Uint8Array): Promise<SheetRows> {
  const entries = zipEntries(bytes)
  const workbookXml = await entryText(bytes, entries, 'xl/workbook.xml')
  if (!workbookXml) {
    if (entries.has('content.xml'))
      throw new SpreadsheetError(
        'Es un archivo de LibreOffice (.ods). Guárdalo como «Libro de Excel (.xlsx)» o como CSV.',
      )
    throw unreadable()
  }
  const workbook = parseXml(workbookXml)
  const sheets = elements(workbook, 'sheet')
  const sheet =
    sheets.find(
      (item) => (item.getAttribute('state') ?? 'visible') === 'visible',
    ) ?? sheets[0]
  if (!sheet) throw unreadable()
  const relationId =
    sheet.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    ) ?? sheet.getAttribute('r:id')
  const relationsXml = await entryText(
    bytes,
    entries,
    'xl/_rels/workbook.xml.rels',
  )
  const relation = relationsXml
    ? elements(parseXml(relationsXml), 'Relationship').find(
        (item) => item.getAttribute('Id') === relationId,
      )
    : undefined
  const sheetPath = relation?.getAttribute('Target')
    ? resolveTarget(relation.getAttribute('Target')!)
    : 'xl/worksheets/sheet1.xml'
  const [sheetXml, sharedXml, stylesXml] = await Promise.all([
    entryText(bytes, entries, sheetPath),
    entryText(bytes, entries, 'xl/sharedStrings.xml'),
    entryText(bytes, entries, 'xl/styles.xml'),
  ])
  if (!sheetXml) throw unreadable()
  const shared = sharedXml
    ? elements(parseXml(sharedXml), 'si').map(richText)
    : []
  const percent = percentStyles(stylesXml ? parseXml(stylesXml) : null)
  const rows: SheetRows = []
  let rowNumber = 0
  for (const row of elements(parseXml(sheetXml), 'row')) {
    rowNumber = Number(row.getAttribute('r')) || rowNumber + 1
    if (rowNumber > MAX_ROWS) throw tooManyRows()
    const values: SheetCell[] = []
    let column = -1
    for (const cell of children(row, 'c')) {
      const reference = cell.getAttribute('r')
      column = reference ? columnIndex(reference) : column + 1
      if (column < 0 || column >= MAX_COLUMNS) continue
      const type = cell.getAttribute('t') ?? 'n'
      const raw = children(cell, 'v')[0]?.textContent ?? null
      let value: SheetCell = null
      if (type === 's')
        value = raw === null ? null : (shared[Number(raw)] ?? null)
      else if (type === 'inlineStr') {
        const inline = children(cell, 'is')[0]
        value = inline ? richText(inline) : null
      } else if (type === 'str' || type === 'd') value = raw
      else if (type === 'b') value = raw === '1'
      else if (type === 'e') value = null
      else if (raw !== null && raw.trim() !== '') {
        const number = Number(raw)
        value = Number.isFinite(number)
          ? percent.has(Number(cell.getAttribute('s') ?? 0))
            ? asPercent(number)
            : number
          : raw
      }
      while (values.length < column) values.push(null)
      values[column] = value
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = values
  }
  return rows
}
