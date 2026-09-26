import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  decodeText,
  parseCsv,
  readSpreadsheet,
  SpreadsheetError,
} from '@/lib/spreadsheet'
import { buildWorkbook } from '@/lib/xlsx'

/**
 * Un ZIP comprimido con DEFLATE, como los que guarda Excel. `declaredSize`
 * permite mentir sobre el tamaño descomprimido, como haría un archivo hecho
 * para colgar el navegador.
 */
function deflatedZip(
  files: Record<string, string>,
  declaredSize?: number,
): Blob {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const raw = encoder.encode(text)
    const data = new Uint8Array(deflateRawSync(raw))
    const local = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(8, 8, true)
    view.setUint32(18, data.length, true)
    view.setUint32(22, declaredSize ?? raw.length, true)
    view.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const record = new Uint8Array(46 + nameBytes.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(10, 8, true)
    recordView.setUint32(20, data.length, true)
    recordView.setUint32(24, declaredSize ?? raw.length, true)
    recordView.setUint16(28, nameBytes.length, true)
    recordView.setUint32(42, offset, true)
    record.set(nameBytes, 46)
    locals.push(local, data)
    central.push(record)
    offset += local.length + data.length
  }
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, central.length, true)
  endView.setUint16(10, central.length, true)
  endView.setUint32(12, size, true)
  endView.setUint32(16, offset, true)
  return new Blob(
    [...locals, ...central, end].map(
      (part) => part.slice().buffer as ArrayBuffer,
    ),
  )
}

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationships =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** Un libro como lo escribe Excel: cadenas compartidas, estilos y dos hojas. */
function excelBook(sheet: string, options: { hiddenFirst?: boolean } = {}) {
  return deflatedZip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="${relationships}"><sheets>${
      options.hiddenFirst
        ? '<sheet name="Oculta" sheetId="9" state="hidden" r:id="rId9"/>'
        : ''
    }<sheet name="Precios" sheetId="1" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="x" Target="/xl/worksheets/precios.xml"/><Relationship Id="rId9" Type="x" Target="worksheets/oculta.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${main}"><si><t>Código</t></si><si><t>Precio de compra</t></si><si><r><t>% Emp</t></r><r><rPr><b/></rPr><t>rendedor</t></r><rPh><t>ふりがな</t></rPh></si><si><t>LCP-0001</t></si></sst>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="170" formatCode="0.0&quot;%&quot;;[Red]\\-0.0%"/><numFmt numFmtId="171" formatCode="&quot;%&quot;0"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>`,
    'xl/worksheets/precios.xml': sheet,
    'xl/worksheets/oculta.xml': `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hoja oculta</t></is></c></row></sheetData></worksheet>`,
  })
}

describe('CSV', () => {
  it('reads Spanish Excel files: semicolons and decimal commas', () => {
    expect(
      parseCsv('Código;Precio de compra;% VIP\r\nLCP-0001;"1.250,50";15\r\n'),
    ).toEqual([
      ['Código', 'Precio de compra', '% VIP'],
      ['LCP-0001', '1.250,50', '15'],
    ])
  })

  it('reads commas, tabs, quotes, embedded line breaks and the sep= hint', () => {
    expect(parseCsv('a,b\n"x, y","com""illas"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'com"illas'],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('"nota\nlarga";b\n1;2')).toEqual([
      ['nota\nlarga', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('sep=,\na;b,c\n')).toEqual([['a;b', 'c']])
    expect(parseCsv('\uFEFFa;b\n\n1;2\n')).toEqual([
      ['a', 'b'],
      [''],
      ['1', '2'],
    ])
  })

  it('keeps accents from UTF-8, UTF-16 and the Windows code page', () => {
    const utf8 = new TextEncoder().encode('Tamaño;Jazmín')
    expect(decodeText(utf8)).toBe('Tamaño;Jazmín')
    expect(
      decodeText(new Uint8Array([0x54, 0x61, 0x6d, 0x61, 0xf1, 0x6f])),
    ).toBe('Tamaño')
    const utf16 = new Uint8Array([0xff, 0xfe, 0xf1, 0x00, 0x61, 0x00])
    expect(decodeText(utf16)).toBe('ña')
  })

  it('reads a CSV file end to end', async () => {
    const file = new Blob([
      new Uint8Array([0x43, 0xf3, 0x64, 0x69, 0x67, 0x6f, 0x3b, 0x78, 0x0a]),
    ])
    await expect(readSpreadsheet(file)).resolves.toEqual([['Código', 'x']])
  })
})

describe('Excel (.xlsx)', () => {
  it('reads the workbook the app writes (stored entries)', async () => {
    const book = buildWorkbook([
      {
        name: 'Hoja',
        notes: ['Título'],
        columns: [
          { header: 'Código' },
          { header: 'Precio de compra', format: 'money' },
        ],
        rows: [
          ['LCP-0001', 500],
          ['LCP-0002', null],
        ],
      },
    ])
    await expect(readSpreadsheet(book)).resolves.toEqual([
      ['Título'],
      [],
      ['Código', 'Precio de compra'],
      ['LCP-0001', 500],
      ['LCP-0002'],
    ])
  })

  it('reads a compressed Excel book: shared strings, rich text, gaps and percentages', async () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="${main}"><sheetData>
      <row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="D2" t="s"><v>2</v></c></row>
      <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>500.5</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" s="1"><v>0.2</v></c><c r="E3" s="2"><v>12.5</v></c><c r="F3" s="3"><v>7</v></c></row>
      <row r="5"><c r="A5" t="str"><f>A3</f><v>LCP-0001</v></c><c r="B5" t="e"><v>#N/A</v></c><c r="D5" s="1"><v>0.155</v></c></row>
    </sheetData></worksheet>`
    await expect(
      readSpreadsheet(excelBook(sheet, { hiddenFirst: true })),
    ).resolves.toEqual([
      [],
      ['Código', 'Precio de compra', null, '% Emprendedor'],
      ['LCP-0001', 500.5, true, '20%', 12.5, 7],
      [],
      ['LCP-0001', null, null, '15.5%'],
    ])
  })

  it('refuses old .xls, LibreOffice, broken and empty files with a clear message', async () => {
    const xls = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])])
    await expect(readSpreadsheet(xls)).rejects.toThrow(/Excel antiguo/)
    const ods = deflatedZip({ 'content.xml': '<x/>', mimetype: 'x' })
    await expect(readSpreadsheet(ods)).rejects.toThrow(/LibreOffice/)
    const broken = new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])])
    await expect(readSpreadsheet(broken)).rejects.toBeInstanceOf(
      SpreadsheetError,
    )
    await expect(readSpreadsheet(new Blob([]))).rejects.toThrow(/vacío/)
    const badXml = excelBook('<worksheet><sheetData><row></worksheet>')
    await expect(readSpreadsheet(badXml)).rejects.toThrow(/No pudimos leer/)
  })

  it('stops a file that expands far beyond its size', async () => {
    const huge = deflatedZip({
      'xl/workbook.xml': `<workbook xmlns="${main}" xmlns:r="${relationships}"><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>`,
      'xl/worksheets/sheet1.xml': ' '.repeat(70 * 1024 * 1024),
    })
    expect(huge.size).toBeLessThan(1024 * 1024)
    await expect(readSpreadsheet(huge)).rejects.toThrow(/demasiado grande/)
    // Aunque el archivo declare 100 bytes, la lectura se corta al pasar el tope.
    const lying = deflatedZip(
      {
        'xl/workbook.xml': `<workbook xmlns="${main}" xmlns:r="${relationships}"><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>`,
        'xl/worksheets/sheet1.xml': ' '.repeat(70 * 1024 * 1024),
      },
      100,
    )
    await expect(readSpreadsheet(lying)).rejects.toThrow(/demasiado grande/)
  })
})
