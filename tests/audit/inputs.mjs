// Datos errados en todos los campos: en cada pantalla y en cada diálogo que se
// abre desde ella, escribe el mismo valor malo en todos los campos, intenta
// guardar y comprueba que la pantalla no se rompa, no ejecute código, no
// enseñe mensajes internos y que la base no guarde números rotos.
//
//   node tests/audit/inputs.mjs
//
// Base desechable y API de Supabase simulada; no toca la base real.
import { writeFileSync, mkdirSync } from 'node:fs'
import { startAudit, go, settle, brokenScreen } from './ui-support.mjs'

const audit = await startAudit({ port: Number(process.env.PORT ?? 5183) })
const { base, seed, events, open, login, USERS } = audit
const ROUTES = [
  '/',
  '/inventory',
  '/inventory/history',
  '/scanner',
  '/sales',
  '/sales/history',
  '/proformas',
  '/proformas/history',
  '/customers',
  '/suppliers',
  '/staff',
  '/settings',
  '/products/new',
  `/products/${seed.products[0]}/edit`,
  '/account',
  '/reports',
  '/alerts',
]
const PUBLIC = ['/login', '/forgot-password', '/activate', '/reset-password']
const BAD = [
  ['vacío', ''],
  ['sólo espacios', '     '],
  ['letras', 'abc'],
  ['negativo', '-5'],
  ['cero', '0'],
  ['muchos decimales', '1.23456789'],
  ['coma decimal', '12,5'],
  ['enorme', '999999999999999999'],
  ['notación científica', '1e308'],
  ['HTML con código', '<img src=x onerror="window.__xss=1">'],
  ['comillas y SQL', `O'Brien"; drop table public.products;--`],
  ['texto de 3000 caracteres', 'x'.repeat(3000)],
  ['emojis', '😀🔥💥'],
  ['dígitos árabes', '١٢٣'],
]
// Por campo, los valores que más dicen; todos a la vez, la lista completa.
const FIELD_BAD = [
  ['vacío', ''],
  ['sólo espacios', '     '],
  ['letras', 'abc'],
  ['negativo', '-5'],
  ['enorme', '999999999999999999'],
  ['HTML con código', '<img src=x onerror="window.__xss=1">'],
  ['texto de 3000 caracteres', 'x'.repeat(3000)],
]
const OPENERS =
  /^(Nuevo|Nueva|Editar|Registrar|Agregar|Añadir|Costo inicial|Cargar costo|Cambiar|Ajustar|Autorizar|Entrada|Salida|Dañado|Ajuste|Movimiento|Sumar|Descontar|Eliminar|Retirar|Anular|Buscar|Escribir|Cargar|Invitar)/i
const SUBMIT =
  /^(Guardar|Registrar|Emitir|Confirmar|Crear|Enviar|Autorizar|Aplicar|Iniciar sesión|Cambiar|Actualizar|Eliminar|Retirar|Anular|Buscar|Agregar|Añadir|Continuar|Aceptar)/i
const results = []
const problems = []

const FIELDS =
  'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])'
async function scopeHandle(page, inDialog) {
  if (
    !inDialog ||
    !(await page
      .locator(
        '[role="dialog"]:visible, [role="alertdialog"]:visible, dialog[open]',
      )
      .count())
  )
    return page.locator('main, .main-content, body').first()
  return page
    .locator(
      '[role="dialog"]:visible, [role="alertdialog"]:visible, dialog[open]',
    )
    .last()
}
/** Un valor razonable según el tipo y la etiqueta, para aislar el campo que se prueba. */
async function sensible(field) {
  const type = (await field.getAttribute('type')) ?? 'text'
  const label = (
    (await field.getAttribute('aria-label')) ||
    (await field.evaluate(
      (el) => el.labels?.[0]?.innerText ?? el.placeholder ?? el.name ?? '',
    )) ||
    ''
  ).toLowerCase()
  if (type === 'email' || /correo/.test(label)) return 'prueba@example.com'
  if (type === 'password' || /contraseña/.test(label))
    return 'Clave-segura-2026'
  if (type === 'tel' || /teléfono|whatsapp/.test(label)) return '88887777'
  if (type === 'date') return '2026-09-28'
  if (
    type === 'number' ||
    /cantidad|costo|precio|monto|tasa|porcentaje|%|mínimo|tamaño|envío|impuesto/.test(
      label,
    )
  )
    return '1'
  if (/ruc|cédula/.test(label)) return 'J0310000000000'
  if (/código|ean|barras/.test(label)) return ''
  if (/buscar/.test(label)) return ''
  return 'Texto de prueba'
}
async function prepare(page, scope) {
  const fields = scope.locator(FIELDS)
  const count = await fields.count()
  const visible = []
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index)
    if (!(await field.isVisible().catch(() => false))) continue
    const current = await field.inputValue().catch(() => '')
    if (!current)
      await field.fill(await sensible(field), { timeout: 3000 }).catch(() => {})
    visible.push(index)
  }
  return visible
}
async function fillOne(page, field, value) {
  const type = (await field.getAttribute('type')) ?? 'text'
  try {
    if (type === 'date' || type === 'month' || type === 'time') {
      await field.fill('')
      if (value)
        await field.evaluate((el) => {
          el.value = '2026-02-31'
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        })
    } else if (type === 'number') {
      await field.fill('')
      await field.pressSequentially(value.slice(0, 40), {
        delay: 0,
        timeout: 3000,
      })
    } else await field.fill(value, { timeout: 3000 })
    return true
  } catch {
    return false
  }
}
async function fill(page, scope, value) {
  const fields = scope.locator(FIELDS)
  const count = await fields.count()
  let filled = 0
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index)
    if (!(await field.isVisible().catch(() => false))) continue
    const type = (await field.getAttribute('type')) ?? 'text'
    try {
      if (type === 'date' || type === 'month' || type === 'time') {
        // Un campo de fecha sólo admite fechas: se prueba vacío o una fecha imposible.
        await field.fill('')
        if (value)
          await field.evaluate((el) => {
            el.value = '2026-02-31'
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          })
      } else if (type === 'number') {
        await field.fill('')
        await field.pressSequentially(value.slice(0, 40), {
          delay: 0,
          timeout: 3000,
        })
      } else {
        await field.fill(value, { timeout: 3000 })
      }
      filled++
    } catch {
      // Campo que no admite el texto (por ejemplo, un número con letras): correcto.
    }
  }
  return filled
}
async function submit(page, scope) {
  const typed = scope.locator('button[type="submit"]:visible')
  if (await typed.count()) {
    const button = typed.last()
    if (await button.isEnabled()) {
      await button.click({ timeout: 3000 }).catch(() => {})
      return 'enviado'
    }
    return 'botón deshabilitado'
  }
  const buttons = scope.getByRole('button', { name: SUBMIT })
  const count = await buttons.count()
  for (let index = count - 1; index >= 0; index--) {
    const button = buttons.nth(index)
    if (!(await button.isVisible())) continue
    if (!(await button.isEnabled())) return 'botón deshabilitado'
    await button.click({ timeout: 3000 }).catch(() => {})
    return 'enviado'
  }
  await page.keyboard.press('Enter')
  return 'Enter'
}
async function feedback(page) {
  return page.evaluate(() => {
    const alerts = [
      ...document.querySelectorAll(
        '[role="alert"], [role="status"], .field-error, [aria-invalid="true"]',
      ),
    ]
      .filter((el) => el.getClientRects().length)
      .map((el) =>
        el.getAttribute('aria-invalid') === 'true'
          ? `campo «${el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.name}» marcado`
          : el.innerText.trim(),
      )
      .filter(Boolean)
    const native = [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.validationMessage && el.getClientRects().length)
      .map((el) => `navegador: ${el.validationMessage}`)
    return [...new Set([...alerts, ...native.slice(0, 1)])]
      .join(' · ')
      .replace(/\s+/g, ' ')
      .slice(0, 220)
  })
}
async function contexts(page) {
  // Los botones de la pantalla que abren un diálogo con campos.
  const names = await page.evaluate((pattern) => {
    const regex = new RegExp(pattern, 'i')
    const seen = new Set()
    return [
      ...document.querySelectorAll(
        'main button, .main-content button, main [role="button"]',
      ),
    ]
      .filter((el) => el.getClientRects().length && !el.disabled)
      .map((el) =>
        (el.getAttribute('aria-label') || el.innerText)
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((name) => regex.test(name) && !seen.has(name) && seen.add(name))
  }, OPENERS.source)
  // Uno por tipo: «Editar Ana López» y «Editar Carlos Ruiz» usan el mismo formulario.
  const byVerb = new Map()
  for (const name of names) {
    const verb =
      name.split(' ')[0] +
      (/costo|compra|precio|porcentaje/i.test(name)
        ? name.match(/costo|compra|precio|porcentaje/i)[0]
        : '')
    if (!byVerb.has(verb)) byVerb.set(verb, name)
  }
  return [null, ...byVerb.values()]
}
async function openContext(page, route, opener) {
  await base.restore()
  await go(page, route === '/account' ? '/' : '/account')
  await go(page, route)
  if (!opener) return true
  const fieldsBefore = await page.locator(FIELDS).count()
  const button = page.getByRole('button', { name: opener, exact: true }).first()
  if (!(await button.isVisible().catch(() => false))) return false
  await button.click({ timeout: 3000 }).catch(() => {})
  await settle(page, 4000)
  // Un diálogo, o un formulario que aparece dentro de la pantalla (proveedores).
  if (
    (await page
      .locator(
        '[role="dialog"]:visible, [role="alertdialog"]:visible, dialog[open]',
      )
      .count()) > 0
  )
    return 'dialog'
  return (await page.locator(FIELDS).count()) > fieldsBefore ? 'inline' : false
}

async function run(page, route, role, viewport, isPublic = false) {
  if (isPublic) await page.goto(`${audit.origin}${route}`)
  else await openContext(page, route, null)
  await settle(page)
  const openers = isPublic ? [null] : await contexts(page)
  const reopen = async (opener) => {
    if (isPublic) {
      await page.goto(`${audit.origin}${route}`)
      await settle(page)
      return true
    }
    return openContext(page, route, opener)
  }
  for (const opener of openers) {
    if (!(await reopen(opener))) continue
    const fieldCount = (await prepare(page, await scopeHandle(page, !!opener)))
      .length
    // Cada campo por separado (los demás con datos válidos) y, al final, todos a la vez.
    const plan = []
    for (let f = 0; f < fieldCount; f++)
      for (const bad of FIELD_BAD) plan.push([f, ...bad])
    for (const bad of BAD) plan.push([-1, ...bad])
    for (const [fieldIndex, label, value] of plan) {
      if (!(await reopen(opener))) break
      const scope = await scopeHandle(page, !!opener)
      const errorsBefore = events.errors.length
      const visible = await prepare(page, scope)
      let filled
      let fieldName = 'todos los campos'
      if (fieldIndex < 0) filled = await fill(page, scope, value)
      else {
        const field = scope.locator(FIELDS).nth(visible[fieldIndex] ?? 0)
        fieldName = await field
          .evaluate(
            (el) =>
              el.getAttribute('aria-label') ||
              el.labels?.[0]?.innerText?.trim() ||
              el.placeholder ||
              el.name ||
              el.type,
          )
          .catch(() => '?')
        filled = (await fillOne(page, field, value)) ? 1 : 0
      }
      if (!filled) continue
      const action = await submit(page, scope)
      await settle(page, 5000)
      await page.waitForTimeout(300)
      const broken = await brokenScreen(page)
      const xss = await page.evaluate(() => window.__xss === 1)
      const message = await feedback(page)
      const where = `${route}${opener ? ` › ${opener}` : ''} › ${fieldName}`
      results.push({
        viewport,
        role,
        where,
        value: label,
        fields: filled,
        action,
        message,
      })
      if (broken)
        problems.push({ viewport, role, where, value: label, problem: broken })
      if (xss)
        problems.push({
          viewport,
          role,
          where,
          value: label,
          problem: 'se ejecutó el código del campo',
        })
      for (const error of events.errors.slice(errorsBefore))
        problems.push({ viewport, role, where, value: label, problem: error })
      for (const place of await brokenNumbers())
        problems.push({
          viewport,
          role,
          where,
          value: label,
          problem: `quedó guardado NaN/Infinity en ${place}`,
        })
    }
    save()
    process.stdout.write(
      `  ${viewport} · ${role} · ${route}${opener ? ` › ${opener}` : ''}\n`,
    )
  }
}

function save() {
  mkdirSync('output/audit', { recursive: true })
  writeFileSync(
    process.env.OUT ?? 'output/audit/inputs.json',
    JSON.stringify(
      {
        results,
        problems,
        unknown: [...audit.api.unknown],
        apiFailures: audit.api.failures,
      },
      null,
      2,
    ),
  )
}
/** Consulta única: cualquier NaN o infinito guardado en una columna numérica. */
let brokenNumbersSql = null
async function brokenNumbers() {
  if (!brokenNumbersSql) {
    const numeric =
      await base.asOwner(`select table_name as t, column_name as c from information_schema.columns
      where table_schema='public' and data_type in ('numeric','double precision','real')`)
    brokenNumbersSql = numeric
      .map(
        ({ t, c }) =>
          `select '${t}.${c}' as place from public.${t} where ${c}::text in ('NaN','Infinity','-Infinity')`,
      )
      .join(' union all ')
  }
  return (await base.asOwner(brokenNumbersSql)).map((row) => row.place)
}

try {
  for (const viewport of (process.env.VIEWPORTS ?? 'desktop').split(',')) {
    const size =
      viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 }
    const { context, page } = await open(size, viewport === 'mobile')
    await login(page, USERS.owner)
    for (const route of ROUTES)
      if (
        !process.env.ONLY_ROUTES ||
        process.env.ONLY_ROUTES.split(',').includes(route)
      )
        await run(page, route, 'owner', viewport)
    await context.close()
    if (process.env.SKIP_PUBLIC) continue
    const guest = await open(size, viewport === 'mobile')
    for (const route of PUBLIC)
      await run(guest.page, route, 'sin sesión', viewport, true)
    await guest.context.close()
  }
} catch (error) {
  console.log('ERROR DEL RECORRIDO:', error.stack)
} finally {
  save()
  console.log(
    `\n${results.length} envíos con datos errados; ${problems.length} observaciones.`,
  )
  for (const p of problems.slice(0, 80))
    console.log(
      `✘ [${p.viewport}/${p.role}] ${p.where} · ${p.value}: ${p.problem}`,
    )
  if (audit.api.failures.length)
    console.log(
      'Errores internos de la API simulada:\n' +
        audit.api.failures.slice(0, 15).join('\n'),
    )
  await audit.stop()
  process.exit(0)
}
