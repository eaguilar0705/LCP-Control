import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { statementCurrency } = await server.ssrLoadModule(
  '/src/features/accounting/statementCurrency.ts',
)
const { accountingWorkbookSheets } = await server.ssrLoadModule(
  '/src/features/accounting/accountingWorkbook.ts',
)
const { journalModel } = await server.ssrLoadModule(
  '/src/features/accounting/journalModel.ts',
)
const { buildWorkbook } = await server.ssrLoadModule('/src/lib/xlsx.ts')
await server.close()

test('la balanza convierte todos los importes con la tasa configurada sin cambiar el costo contable', () => {
  const nio = statementCurrency()
  for (const rate of [37, 38.5, 36.6243]) {
    const usd = statementCurrency({ currency: 'USD', exchangeRate: rate })
    assert.equal(usd.convert(59063.46), 59063.46 / rate)
    assert.equal(usd.convert(-21360), -21360 / rate)
    assert.equal(usd.convert(0), 0)
    assert.equal(usd.convert(null), null)
    assert.equal(nio.convert(59063.46), 59063.46)
    assert.match(usd.label, new RegExp(String(rate).replace('.', '\\.')))
  }
  assert.equal(
    statementCurrency({ currency: 'USD', exchangeRate: 37 })
      .convert(59063.46)
      .toFixed(2),
    '1596.31',
  )
})

test('sin tasa válida no inventa equivalencias ni afecta la consulta en córdobas', () => {
  for (const exchangeRate of [null, undefined, 0, -37, NaN, Infinity]) {
    assert.throws(
      () => statementCurrency({ currency: 'USD', exchangeRate }),
      /tipo de cambio/,
    )
    assert.equal(
      statementCurrency({ currency: 'NIO', exchangeRate }).convert(21360),
      21360,
    )
  }
})

test('Excel y pantalla comparten conversión sin redondear antes de sumar ni mutar el modelo', async () => {
  const accounts = [
    ['1130', 'Inventario', 'asset', 'debit', 808448.97, 21360, 59063.46],
    ['5120', 'Costo de venta', 'cost', 'debit', 0, 59063.46, 0],
    ['3110-001', 'Capital', 'equity', 'credit', -808448.97, 0, 21360],
  ].map(([code, name, bucket, nature, opening, debit, credit]) => ({
    code,
    name,
    bucket,
    nature,
    opening,
    debit,
    credit,
    closing: opening + debit - credit,
    postable: true,
    parent: null,
  }))
  const model = journalModel(
    {
      startOn: '2026-11-01',
      from: '2026-11-01',
      to: '2026-11-06',
      missingCosts: 0,
      missingSales: 0,
      accounts,
      entries: [],
    },
    'La Casa del Perfume',
  )
  const before = JSON.stringify(model)
  const nio = accountingWorkbookSheets(model)
  const usd = accountingWorkbookSheets(model, {
    currency: 'USD',
    exchangeRate: 37,
  })
  assert.deepEqual(nio[0], usd[0])
  assert.equal(usd.length, 4)
  const inventory = usd[1].rows.find((r) => r[0] === '1130')
  assert.equal(inventory[2], 808448.97 / 37)
  assert.equal(inventory[3], 21360 / 37)
  assert.equal(inventory[4], 59063.46 / 37)
  assert.equal(inventory[5], 770745.51 / 37)
  assert.equal(nio[1].rows.find((r) => r[0] === '1130')[4], 59063.46)
  for (let sheet = 1; sheet < 4; sheet++) {
    assert.ok(
      usd[sheet].notes.some(
        (note) => note.includes('USD equivalentes') && note.includes('37'),
      ),
    )
    usd[sheet].rows.forEach((row, i) =>
      row.forEach((v, j) => {
        const original = nio[sheet].rows[i][j]
        if (typeof original === 'number') assert.equal(v, original / 37)
        else assert.equal(v, original)
      }),
    )
  }
  assert.equal(usd[3].columns[2].header, 'Saldo USD')
  assert.equal(JSON.stringify(model), before)
  // Comprueba el archivo real, con cifras numéricas y tasa visible.
  const bytes = Buffer.from(await buildWorkbook(usd).arrayBuffer())
  const files = new Map()
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const size = bytes.readUInt32LE(offset + 18)
    const length = bytes.readUInt16LE(offset + 26)
    const extra = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + length + extra
    files.set(
      bytes.subarray(offset + 30, offset + 30 + length).toString(),
      bytes.subarray(start, start + size).toString(),
    )
    offset = start + size
  }
  assert.ok(
    files.get('xl/worksheets/sheet2.xml').includes(`<v>${59063.46 / 37}</v>`),
  )
  assert.ok(
    files
      .get('xl/worksheets/sheet2.xml')
      .includes('Tasa del sistema: C$37 por US$1'),
  )
  model.trial[0].closingNio = null
  assert.equal(
    accountingWorkbookSheets(model, { currency: 'USD', exchangeRate: 37 })[1]
      .rows[0][5],
    'Pendiente',
  )
})
