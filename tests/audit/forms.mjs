// Datos errados en los formularios que mueven dinero o existencias, con todo lo
// demás bien llenado: cada caso tiene que avisar a la persona y no cambiar
// nada en la base. Complementa a inputs.mjs, que no sabe elegir un perfume ni
// agregar renglones a una factura.
//
//   node tests/audit/forms.mjs
//
// Base desechable y API de Supabase simulada; no toca la base real.
import { writeFileSync, mkdirSync } from 'node:fs'
import { startAudit, go, settle, brokenScreen } from './ui-support.mjs'
import { fingerprint } from './harness.mjs'

const audit = await startAudit({ port: Number(process.env.PORT ?? 5191) })
const { base, seed, events, open, login, USERS } = audit
let checks = 0
let failures = 0
const rows = []
const check = (ok, text, detail = '') => {
  checks++
  console.log(`${ok ? '✔' : '✘'} ${text}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const baseline = await fingerprint(base.asOwner, {
  exclude: ['private.rate_limits'],
})

/** Lo que la pantalla le dice a la persona después de intentar guardar. */
async function feedback(page) {
  return page.evaluate(() => {
    const visible = (el) => el.getClientRects().length
    const texts = [
      ...document.querySelectorAll(
        '[role="alert"], [role="status"], .field-error, .inline-error',
      ),
    ]
      .filter(visible)
      .map((el) => el.innerText.trim())
      .filter(Boolean)
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')]
      .filter(visible)
      .map(
        (el) =>
          `campo marcado: ${el.labels?.[0]?.innerText?.split('\n')[0] ?? el.getAttribute('aria-label') ?? el.name}`,
      )
    const native = [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => visible(el) && el.validationMessage)
      .map((el) => `navegador: ${el.validationMessage}`)
    return [...new Set([...texts, ...invalid, ...native.slice(0, 1)])]
      .join(' · ')
      .replace(/\s+/g, ' ')
      .slice(0, 200)
  })
}
async function choose(dialog, label, search) {
  await dialog.getByRole('button', { name: new RegExp(label) }).click()
  await dialog.getByRole('combobox', { name: /Buscar/ }).fill(search)
  await dialog.getByRole('combobox', { name: /Buscar/ }).press('Enter')
}

/**
 * Un caso: base limpia, pantalla desde cero, llenar, enviar. Pasa si la
 * pantalla avisa (o deja el botón deshabilitado), no cambia la base, no se
 * rompe y no hay errores en la consola.
 */
async function scenario(page, { area, text, route, run }) {
  await base.restore()
  await go(page, route === '/account' ? '/' : '/account')
  await go(page, route)
  const errors = events.errors.length
  let outcome
  try {
    outcome = (await run(page)) ?? ''
  } catch (error) {
    outcome = `no se pudo completar el caso: ${error.message.split('\n')[0]}`
  }
  await settle(page, 5000)
  await page.waitForTimeout(300)
  const message = outcome || (await feedback(page))
  const after = await fingerprint(base.asOwner, {
    exclude: ['private.rate_limits'],
  })
  const changed = Object.keys(after).filter(
    (t) => after[t].hash !== baseline[t].hash,
  )
  const broken = await brokenScreen(page)
  const newErrors = events.errors.slice(errors)
  const ok =
    !!message &&
    !message.startsWith('no se pudo') &&
    !changed.length &&
    !broken &&
    !newErrors.length
  rows.push({ area, text, message, changed, broken, errors: newErrors })
  check(
    ok,
    `${area}: ${text} → ${message || 'SIN AVISO'}`,
    [changed.length && `cambió ${changed.join(', ')}`, broken, ...newErrors]
      .filter(Boolean)
      .join(' | '),
  )
  if (!ok) {
    mkdirSync('output/audit/shots', { recursive: true })
    await page
      .screenshot({
        path: `output/audit/shots/form-${`${area}-${text}`.replace(/[^\wáéíóúñ]+/gi, '-')}.png`,
        fullPage: true,
      })
      .catch(() => {})
  }
}
const disabled = async (button) =>
  (await button.isDisabled()) ? 'botón deshabilitado' : null

const [oud] = seed.products
try {
  const { page } = await open()
  page.setDefaultTimeout(8000)
  await login(page, USERS.owner)

  // --- Movimientos de inventario -------------------------------------------
  const movement = (
    type,
    quantity,
    note = 'Motivo de prueba',
    product = 'Oud Nocturno',
  ) => ({
    area: `Inventario › ${type}`,
    route: '/inventory',
    run: async (page) => {
      await page.getByRole('button', { name: type, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await choose(dialog, 'Producto del movimiento', product)
      await dialog.getByLabel('Ubicación').selectOption('store')
      await dialog.getByLabel(/Cantidad|Conteo/).fill(quantity)
      await dialog.getByLabel('Motivo').fill(note)
      await dialog
        .getByRole('button', {
          name: /Guardar movimiento|Confirmar movimiento/,
        })
        .click()
      await settle(page)
      const confirm = page
        .getByRole('button', { name: /Confirmar movimiento|Registrar/ })
        .last()
      if (await confirm.isVisible().catch(() => false)) await confirm.click()
    },
  })
  for (const [type, quantity, note, text] of [
    ['Salida', '0', undefined, 'cantidad 0'],
    ['Salida', '-3', undefined, 'cantidad negativa'],
    ['Salida', '1.5', undefined, 'cantidad con decimales'],
    ['Salida', '999', undefined, 'más de lo que hay (7 en tienda)'],
    ['Salida', '1', '   ', 'motivo de espacios'],
    ['Dañado', '100000000', undefined, 'cantidad enorme'],
    ['Ajuste', '-1', undefined, 'conteo negativo'],
    ['Ajuste', '2.5', undefined, 'conteo con decimales'],
    ['Entrada', '2', undefined, 'entrada manual de un perfume con costo'],
  ])
    await scenario(page, { ...movement(type, quantity, note), text })

  // --- Perfume --------------------------------------------------------------
  const productCase = (fill, text) => ({
    area: 'Perfume › editar',
    text,
    route: `/products/${oud}/edit`,
    run: async (page) => {
      await fill(page)
      await page.getByRole('button', { name: 'Guardar perfume' }).click()
    },
  })
  const newProductCase = (fill, text) => ({
    area: 'Perfume › crear',
    text,
    route: '/products/new',
    run: async (page) => {
      await page.getByLabel('Nombre del perfume').fill('Prueba precio inválido')
      await page.getByLabel('Marca', { exact: true }).fill('Marca prueba')
      await page.getByLabel('Emprendedor USD').fill('20')
      await page.getByLabel('VIP USD').fill('18')
      await page.getByLabel('Premium USD').fill('16')
      await fill(page)
      await page.getByRole('button', { name: 'Guardar perfume' }).click()
    },
  })
  for (const [text, fill, sinCosto] of [
    ['nombre vacío', (p) => p.getByLabel('Nombre del perfume').fill('')],
    [
      'tamaño negativo',
      (p) => p.getByLabel('Tamaño (vacío si falta confirmar)').fill('-100'),
    ],
    [
      'EAN de 3 dígitos',
      (p) => p.getByLabel('Código del fabricante (EAN / UPC)').fill('123'),
    ],
    ['mínimo negativo', (p) => p.getByLabel('Mínimo de inventario').fill('-1')],
    [
      'precio Emprendedor negativo',
      (p) => p.getByLabel('Emprendedor USD').fill('-5'),
      true,
    ],
    ['precio VIP en 0', (p) => p.getByLabel('VIP USD').fill('0'), true],
    [
      'precio con 3 decimales',
      (p) => p.getByLabel('Premium USD').fill('10.555'),
      true,
    ],
  ])
    await scenario(
      page,
      sinCosto ? newProductCase(fill, text) : productCase(fill, text),
    )

  for (const [text, label, value] of [
    ['porcentaje de ganancia negativo', '% de ganancia · Emprendedor', '-5'],
    ['porcentaje de ganancia de 5000', '% de ganancia · VIP', '5000'],
  ])
    await scenario(page, {
      area: 'Contabilidad › precios',
      text,
      route: '/accounting',
      run: async (page) => {
        await page.getByRole('button', { name: 'Precios', exact: true }).click()
        await page
          .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
          .click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel(label, { exact: true }).fill(value)
        await dialog
          .getByRole('button', { name: 'Guardar precios', exact: true })
          .click()
      },
    })

  // --- Negocio, usuarios y cuenta ------------------------------------------
  for (const [text, value] of [
    ['tasa 0', '0'],
    ['tasa negativa', '-36'],
    ['tasa enorme', '999999'],
  ])
    await scenario(page, {
      area: 'Negocio › tipo de cambio',
      text,
      route: '/settings',
      run: async (page) => {
        await page.getByLabel('Córdobas por 1 dólar').fill(value)
        const button = page
          .getByRole('button', { name: 'Actualizar tasa' })
          .first()
        if (await button.isDisabled()) return 'botón deshabilitado'
        await button.click()
      },
    })
  await scenario(page, {
    area: 'Negocio › datos',
    text: 'nombre comercial de espacios',
    route: '/settings',
    run: async (page) => {
      await page.getByLabel('Nombre comercial').fill('    ')
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    },
  })
  for (const [text, email, name] of [
    ['correo «ventas@»', 'ventas@', 'Persona'],
    ['nombre vacío', 'nueva@example.com', ''],
  ])
    await scenario(page, {
      area: 'Usuarios › autorizar',
      text,
      route: '/staff',
      run: async (page) => {
        await page.getByRole('button', { name: /Autorizar correo/ }).click()
        const scope = page.getByRole('dialog').or(page.locator('main')).first()
        await scope.getByLabel('Correo').fill(email)
        await scope.getByLabel('Nombre').fill(name)
        await scope
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
      },
    })
  for (const [text, a, b] of [
    ['contraseña de 6 caracteres', 'abc123', 'abc123'],
    ['contraseñas distintas', 'Clave-muy-segura-1', 'Clave-muy-segura-2'],
  ])
    await scenario(page, {
      area: 'Mi cuenta › contraseña',
      text,
      route: '/account',
      run: async (page) => {
        await page.getByLabel('Nueva contraseña').fill(a)
        await page.getByLabel('Repetir contraseña').fill(b)
        await page
          .getByRole('button', { name: /contraseña/i })
          .last()
          .click()
      },
    })
  await scenario(page, {
    area: 'Mi cuenta › nombre',
    text: 'nombre de espacios',
    route: '/account',
    run: async (page) => {
      await page.getByLabel('Nombre visible').fill('   ')
      await page.getByRole('button', { name: 'Guardar nombre' }).click()
    },
  })

  // --- Facturación con la cuenta de ventas ---------------------------------
  const { page: sales } = await open()
  sales.setDefaultTimeout(8000)
  await login(sales, USERS.sales)
  const invoice = (fill, text) => ({
    area: 'Facturación',
    text,
    route: '/sales',
    run: async (page) => {
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente de prueba')
      await page.getByLabel('Buscar en catálogo').fill('Oud')
      await page
        .getByRole('button', { name: /^Agregar .*Oud Nocturno/ })
        .first()
        .click()
      await page.getByLabel('Forma de pago').selectOption({ index: 1 })
      await fill(page)
      await page.waitForTimeout(200)
      const button = page.getByRole('button', { name: /^Emitir factura/ })
      const off = await disabled(button)
      if (off)
        return `${off}${(await feedback(page)) ? ` · ${await feedback(page)}` : ''}`
      await button.click()
    },
  })
  for (const [text, fill] of [
    ['cantidad 0', (p) => p.getByLabel(/^Cantidad de .*Oud/).fill('0')],
    ['cantidad negativa', (p) => p.getByLabel(/^Cantidad de .*Oud/).fill('-2')],
    [
      'cantidad con decimales',
      (p) => p.getByLabel(/^Cantidad de .*Oud/).fill('1.5'),
    ],
    [
      'más de lo que hay en tienda (7)',
      (p) => p.getByLabel(/^Cantidad de .*Oud/).fill('50'),
    ],
    ['WhatsApp «123»', (p) => p.getByLabel('WhatsApp del cliente').fill('123')],
    [
      'sin nombre de cliente',
      (p) => p.getByLabel('Cliente', { exact: true }).fill('   '),
    ],
    [
      'en dólares con tasa 0',
      async (p) => {
        await p.getByLabel('Moneda', { exact: true }).selectOption('USD')
        await p.getByLabel('Tipo de cambio (NIO por 1 USD)').fill('0')
      },
    ],
  ])
    await scenario(sales, invoice(fill, text))

  // --- Contabilidad: importes, fecha, tasa y vínculo de los abonos ----------
  const financeCase = (kind, fill, text) => ({
    area: 'Contabilidad › movimientos',
    text,
    route: '/accounting',
    run: async (page) => {
      await page
        .getByRole('button', { name: 'Caja y bancos', exact: true })
        .click()
      await page.getByRole('button', { name: 'Registrar', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Registrar movimiento' })
      await dialog.getByLabel('Tipo', { exact: true }).selectOption(kind)
      await dialog.getByLabel('Importe (NIO)').fill('100')
      await fill(dialog)
      const button = dialog.getByRole('button', {
        name: 'Guardar',
        exact: true,
      })
      const off = await disabled(button)
      if (off) return off
      await button.click()
    },
  })
  for (const [kind, text, fill] of [
    [
      'opening',
      'saldo inicial negativo',
      (d) => d.getByLabel('Importe (NIO)').fill('-1'),
    ],
    [
      'capital',
      'aporte de cero',
      (d) => d.getByLabel('Importe (NIO)').fill('0'),
    ],
    [
      'expense',
      'gasto con descripción de espacios',
      (d) => d.getByLabel('Descripción').fill('   '),
    ],
    [
      'expense',
      'gasto negativo',
      (d) => d.getByLabel('Importe (NIO)').fill('-150'),
    ],
    [
      'transfer',
      'transferencia en USD con tasa cero',
      async (d) => {
        await d.getByLabel('Moneda', { exact: true }).selectOption('USD')
        await d.getByLabel('Tipo de cambio', { exact: true }).fill('0')
      },
    ],
    [
      'capital',
      'fecha futura',
      (d) => d.getByLabel('Fecha', { exact: true }).fill('2099-01-01'),
    ],
    [
      'collection',
      'cobro sin factura o saldo inicial seleccionado',
      async () => {},
    ],
    [
      'supplier_payment',
      'pago sin pedido o saldo inicial seleccionado',
      async () => {},
    ],
  ])
    await scenario(page, financeCase(kind, fill, text))
} catch (error) {
  check(false, 'recorrido', error.stack)
} finally {
  mkdirSync('output/audit', { recursive: true })
  writeFileSync(
    process.env.OUT ?? 'output/audit/forms.json',
    JSON.stringify(rows, null, 2),
  )
  console.log(
    `\n${checks - failures} de ${checks} casos de datos errados rechazados sin cambiar la base.`,
  )
  await audit.stop()
  process.exit(failures ? 1 : 0)
}
