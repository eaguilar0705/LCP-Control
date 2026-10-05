/**
 * Escritor mínimo de libros de Excel (.xlsx), sin dependencias.
 *
 * Un .xlsx es un ZIP con varios XML dentro. Escribirlo a mano son unas pocas
 * decenas de líneas y evita añadir una librería de medio megabyte —y su árbol
 * de dependencias— para volcar tablas de unas cuantas filas. Las entradas del
 * ZIP se guardan sin comprimir: es válido, Excel y LibreOffice lo abren igual,
 * y ahorra implementar DEFLATE. Los reportes rondan las mil filas, así que el
 * archivo sigue siendo pequeño.
 *
 * Las cifras se escriben como números con formato, nunca como texto: quien
 * reciba el archivo debe poder sumar y filtrar sin limpiarlo antes.
 */

export type CellValue = string | number | null
export interface SheetColumn {
  header: string
  /** Ancho en caracteres; Excel no lo deduce del contenido. */
  width?: number
  format?: 'text' | 'number' | 'money' | 'integer' | 'date'
}
export interface Sheet {
  name: string
  columns: SheetColumn[]
  rows: CellValue[][]
  /** Filas de texto libre encima de la tabla (título, periodo, avisos). */
  notes?: string[]
}

const FORMAT_INDEX: Record<NonNullable<SheetColumn['format']>, number> = {
  text: 0,
  integer: 1,
  number: 2,
  money: 3,
  date: 4,
}

// XML 1.0 sólo admite tabulador, salto de línea y retorno entre los caracteres
// de control; cualquier otro hace que Excel rechace el libro completo. Se filtra
// por código en vez de con una expresión regular, donde estos caracteres serían
// invisibles en el editor.
function stripControlCharacters(value: string): string {
  let clean = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (code === 0x7f) continue
    clean += character
  }
  return clean
}

function escapeXml(value: string): string {
  return stripControlCharacters(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 1 -> A, 27 -> AA */
function columnName(index: number): string {
  let name = ''
  let value = index
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

// Excel sólo acepta 31 caracteres y ninguno de : \ / ? * [ ]
function sheetName(name: string, index: number): string {
  const clean = name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)
  return clean.trim() || `Hoja ${index + 1}`
}

function cell(
  reference: string,
  value: CellValue,
  style: number,
  isNumber: boolean,
): string {
  if (value === null || value === '') return ''
  if (isNumber && typeof value === 'number' && Number.isFinite(value))
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`
}

function sheetXml(sheet: Sheet): string {
  const offset = (sheet.notes?.length ?? 0) + (sheet.notes?.length ? 1 : 0)
  const rows: string[] = []

  sheet.notes?.forEach((note, index) => {
    rows.push(
      `<row r="${index + 1}">${cell(`A${index + 1}`, note, index === 0 ? 6 : 5, false)}</row>`,
    )
  })

  const headerRow = offset + 1
  rows.push(
    `<row r="${headerRow}">${sheet.columns
      .map((column, index) =>
        cell(`${columnName(index + 1)}${headerRow}`, column.header, 5, false),
      )
      .join('')}</row>`,
  )

  sheet.rows.forEach((values, rowIndex) => {
    const number = headerRow + rowIndex + 1
    const cells = sheet.columns
      .map((column, index) => {
        const format = column.format ?? 'text'
        return cell(
          `${columnName(index + 1)}${number}`,
          values[index] ?? null,
          FORMAT_INDEX[format],
          format !== 'text' && format !== 'date',
        )
      })
      .join('')
    rows.push(`<row r="${number}">${cells}</row>`)
  })

  const cols = sheet.columns
    .map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? 18}" customWidth="1"/>`,
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

// --- ZIP (entradas sin comprimir) -------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Entry {
  name: string
  bytes: Uint8Array
}

function zip(entries: Entry[]): Blob {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const encoder = new TextEncoder()

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const local = new Uint8Array(30 + name.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true) // versión mínima
    view.setUint16(6, 0x0800, true) // nombres en UTF-8
    view.setUint16(8, 0, true) // sin compresión
    view.setUint32(14, crc, true)
    view.setUint32(18, entry.bytes.length, true)
    view.setUint32(22, entry.bytes.length, true)
    view.setUint16(26, name.length, true)
    local.set(name, 30)
    chunks.push(local, entry.bytes)

    const record = new Uint8Array(46 + name.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint16(8, 0x0800, true)
    recordView.setUint16(10, 0, true)
    recordView.setUint32(16, crc, true)
    recordView.setUint32(20, entry.bytes.length, true)
    recordView.setUint32(24, entry.bytes.length, true)
    recordView.setUint16(28, name.length, true)
    recordView.setUint32(42, offset, true)
    record.set(name, 46)
    central.push(record)
    offset += local.length + entry.bytes.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  // `slice()` copia a un ArrayBuffer propio: Blob no acepta una vista cuyo
  // búfer pudiera ser compartido.
  const parts: BlobPart[] = [...chunks, ...central, end].map(
    (part) => part.slice().buffer as ArrayBuffer,
  )
  return new Blob(parts, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export function buildWorkbook(sheets: Sheet[]): Blob {
  const encoder = new TextEncoder()
  const named = sheets.map((sheet, index) => ({
    ...sheet,
    name: sheetName(sheet.name, index),
  }))
  const files: Entry[] = [
    {
      name: '[Content_Types].xml',
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named
          .map(
            (_, index) =>
              `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('')}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named
          .map(
            (sheet, index) =>
              `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
          )
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
          )
          .join(
            '',
          )}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: 'xl/styles.xml', bytes: encoder.encode(STYLES) },
    ...named.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      bytes: encoder.encode(sheetXml(sheet)),
    })),
  ]
  return zip(files)
}
