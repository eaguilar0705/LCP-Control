import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// Usa los renderizadores reales de factura y proforma, sin crear ventas.
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = path.resolve('output/enterprise-pdf')
await mkdir(output, { recursive: true })
const issuer = {
  name: 'La Casa del Perfume',
  legalName: 'Perfumería Auditoría Empresarial, S. A.',
  taxId: 'J0310000000123',
  branch: 'Sucursal Managua',
  address: 'Managua, Nicaragua. Avenida de auditoría, local 101.',
  phone: '+505 8888-7777',
  email: 'facturacion@example.test',
  billingDetails: 'Serie A. Autorización de auditoría 2026-001.',
}
const items = Array.from({ length: 100 }, (_, index) => {
  const code = String(index + 1).padStart(3, '0')
  const quantity = (index % 3) + 1
  const unitPrice = 875.25 + index * 0.5
  return {
    id: crypto.randomUUID(),
    productId: crypto.randomUUID(),
    description: `PERFUME-${code} ${
      index % 4 === 0
        ? 'Perfume oriental de edición especial con descripción extendida para comprobar la continuidad y lectura completa de la presentación de 3.4 oz'
        : 'Perfume de auditoría empresarial 3.4 oz'
    }`,
    quantity,
    unitPrice,
    lineTotal: Math.round(quantity * unitPrice * 100) / 100,
  }
})
const total =
  Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100
const common = {
  id: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  customerName: 'Cliente Auditoría de documentos',
  customerPhone: '+50588886666',
  customerTaxId: 'J0310000000456',
  issuer,
  tier: 'emprendedor',
  currency: 'NIO',
  exchangeRate: 1,
  catalogRate: 36.6,
  taxRate: 0,
  total,
  location: 'store',
  validUntil: '2026-10-31',
  paymentMethod: 'bac_nio',
  notes:
    'Pedido auditado de cien productos. Entrega completa con su empaque original. MARCADOR-NOTA-FINAL',
  createdAt: '2026-10-24T15:00:00.000Z',
  items,
}
const longName =
  'Comercializadora de Perfumes y Accesorios de Nicaragua Sociedad Anónima para Ventas Mayoristas y Minoristas MARCADOR-CLIENTE-FINAL'
const longNotes =
  'Observaciones completas del pedido para comprobar que ninguna condición de entrega se omita al imprimir. '.repeat(
    13,
  ) + ' MARCADOR-NOTA-LARGA-FINAL'
assert.ok(longName.length <= 160)
assert.ok(longNotes.length <= 1500)
const documents = [
  {
    ...common,
    kind: 'invoice',
    number: 'FAC-900001',
    file: 'factura-100-productos.pdf',
  },
  {
    ...common,
    kind: 'proforma',
    number: 'PRO-900001',
    location: null,
    paymentMethod: null,
    file: 'proforma-100-productos.pdf',
  },
  {
    ...common,
    kind: 'invoice',
    number: 'FAC-900002',
    customerName: longName,
    file: 'factura-cliente-largo.pdf',
  },
  {
    ...common,
    kind: 'invoice',
    number: 'FAC-900003',
    notes: longNotes,
    file: 'factura-notas-largas.pdf',
  },
]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(20000)
try {
  await page.goto(base + '/login')
  for (const document of documents) {
    const bytes = await page.evaluate(async (record) => {
      const { renderDocumentPdf } =
        await import('/src/features/sales/pdfLayout.ts')
      const logo = new Uint8Array(
        await (await fetch('/brand/wordmark-wine.jpeg')).arrayBuffer(),
      )
      return Array.from(
        new Uint8Array(await renderDocumentPdf(record, logo).arrayBuffer()),
      )
    }, document)
    await writeFile(path.join(output, document.file), new Uint8Array(bytes))
  }
} finally {
  await browser.close()
}
await writeFile(
  path.join(output, 'documentos-esperados.json'),
  JSON.stringify(documents, null, 2),
)

const inspect = String.raw`
import json, re, sys
from pathlib import Path
import pdfplumber
data=json.load(sys.stdin)
out=Path(data['output'])
reports=[]
for document in data['documents']:
    issues=[]
    file=out/document['file']
    with pdfplumber.open(file) as pdf:
        pages=[]
        texts=[]
        for index,page in enumerate(pdf.pages,1):
            text=page.extract_text(x_tolerance=1) or ''
            texts.append(text)
            if abs(page.width-612)>.01 or abs(page.height-792)>.01:
                issues.append({'type':'paper-size','page':index,'size':[page.width,page.height]})
            outside=[{'text':c['text'],'box':[c['x0'],c['top'],c['x1'],c['bottom']]} for c in page.chars
                if c['text'].strip() and (c['x0']<28.5 or c['x1']>583.5 or c['top']<20 or c['bottom']>790)]
            if outside: issues.append({'type':'text-outside-margins','page':index,'characters':outside[:8]})
            pages.append({'page':index,'width':page.width,'height':page.height,'characters':len(page.chars),
                'minX':min((c['x0'] for c in page.chars),default=0),'maxX':max((c['x1'] for c in page.chars),default=0),
                'minY':min((c['top'] for c in page.chars),default=0),'maxY':max((c['bottom'] for c in page.chars),default=0)})
        content='\n'.join(texts)
        normalized=' '.join(content.split())
        for item in document['items']:
            marker=item['description'].split(' ')[0]
            found=len(re.findall(re.escape(marker)+r'(?![0-9])',content))
            if found!=1:issues.append({'type':'missing-or-duplicated-product','marker':marker,'count':found})
        for field in ['name','legalName','taxId','branch','address','phone','email','billingDetails']:
            expected=' '.join(document['issuer'][field].split())
            if expected not in normalized:issues.append({'type':'issuer-data-missing','field':field,'expected':expected})
        for field in ['customerName','customerPhone','customerTaxId']:
            expected=' '.join(document[field].split())
            # RUC y teléfono comparten la primera fila con el cliente. La
            # extracción lineal intercalaría sus columnas dentro del nombre.
            column=' '.join((pdf.pages[0].crop((38,90,291,500)).extract_text(x_tolerance=1) or '').split()) if field=='customerName' else normalized
            if expected not in column:issues.append({'type':'customer-data-missing','field':field,'expected':expected})
        if 'MARCADOR-NOTA' not in normalized:issues.append({'type':'notes-missing'})
        if 'MARCADOR-NOTA-LARGA-FINAL' in document['notes'] and 'MARCADOR-NOTA-LARGA-FINAL' not in normalized:
            issues.append({'type':'notes-truncated'})
        if '100 productos' not in normalized:issues.append({'type':'product-count-missing'})
        total=f"{document['total']:,.2f}"
        if total not in normalized:issues.append({'type':'total-missing','total':total})
        if 'TOTAL NIO' not in normalized:issues.append({'type':'total-label-missing'})
        if document['kind']=='invoice':
            for marker in ['Por favor, revise su producto antes de retirarse de la tienda.',
                'En caso de presentar un posible defecto de fabricación,',
                'La presentación de esta factura será necesaria para cualquier solicitud de revisión o cambio.']:
                if marker not in normalized:issues.append({'type':'policy-missing','marker':marker})
        elif 'Cotización sujeta a disponibilidad.' not in normalized:issues.append({'type':'proforma-notice-missing'})
        if not any('TOTAL NIO' in text for text in texts[-1:]):issues.append({'type':'total-not-on-final-page'})
        (out/(document['file']+'.txt')).write_text(content,encoding='utf-8')
        reports.append({'file':document['file'],'pages':pages,'issues':issues,'total':document['total'],'products':len(document['items'])})
(out/'revision-pdf.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(reports,ensure_ascii=False,indent=2))
sys.exit(1 if any(report['issues'] for report in reports) else 0)
`
const checked = spawnSync(process.env.LCP_PYTHON ?? 'python', ['-c', inspect], {
  input: JSON.stringify({ output, documents }),
  encoding: 'utf8',
  maxBuffer: 2e6,
  env: { ...process.env, PYTHONUTF8: '1' },
})
if (checked.stdout) console.log(checked.stdout)
if (checked.stderr) console.error(checked.stderr)
assert.equal(
  checked.status,
  0,
  'PDFs completos, Carta y sin texto fuera de margen; revisar output/enterprise-pdf/revision-pdf.json',
)
