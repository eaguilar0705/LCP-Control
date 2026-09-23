import { createServer } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const server = await createServer({
  server: { middlewareMode: true },
  mode: 'test',
})
try {
  const { renderDocumentPdf } = await server.ssrLoadModule(
    '/src/features/sales/pdfLayout.ts',
  )
  const { exampleDocument } = await server.ssrLoadModule(
    '/src/features/sales/example.ts',
  )
  const logo = new Uint8Array(await readFile('public/brand/wordmark-wine.jpeg'))
  await mkdir('output/pdf', { recursive: true })
  for (const [kind, filename] of [
    ['invoice', 'factura-ejemplo-carta.pdf'],
    ['proforma', 'proforma-ejemplo-carta.pdf'],
  ]) {
    const blob = renderDocumentPdf(exampleDocument(kind), logo)
    await writeFile(
      `output/pdf/${filename}`,
      new Uint8Array(await blob.arrayBuffer()),
    )
    console.log(`Creado output/pdf/${filename}`)
  }
} finally {
  await server.close()
}
