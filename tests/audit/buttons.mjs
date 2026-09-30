// Recorrido de todos los botones: abre cada pantalla con cada rol, pulsa cada
// control visible (y los de los diálogos que abren), y anota errores de consola,
// excepciones, textos internos a la vista y controles que no hacen nada.
// Antes de cada clic la base vuelve a su estado inicial y la pantalla se abre
// de nuevo, así que cada botón se prueba desde cero.
//
//   node tests/audit/buttons.mjs            (escritorio y teléfono)
//   VIEWPORTS=desktop node tests/audit/buttons.mjs
//
// Base desechable y API de Supabase simulada; no toca la base real.
import { writeFileSync, mkdirSync } from 'node:fs'
import { startAudit, go, settle, brokenScreen } from './ui-support.mjs'

const audit = await startAudit({ port: Number(process.env.PORT ?? 5181) })
const { base, seed, events, open, login, USERS } = audit
const [product] = seed.products
const ROUTES = {
  owner: [
    '/',
    '/inventory',
    '/inventory/history',
    '/scanner',
    '/sales',
    '/sales/history',
    '/proformas',
    '/proformas/history',
    '/prices',
    '/prices?apartado=costo',
    '/customers',
    '/suppliers',
    '/staff',
    '/settings',
    '/products/new',
    `/products/${product}/edit`,
    '/account',
    '/reports',
    '/alerts',
  ],
  sales: [
    '/',
    '/inventory',
    '/sales',
    '/sales/history',
    '/proformas',
    '/customers',
    '/prices',
    '/reports',
    '/staff',
    '/settings',
    '/account',
  ],
  warehouse: [
    '/',
    '/inventory',
    '/inventory/history',
    '/sales',
    '/prices',
    '/suppliers',
    '/account',
  ],
}
const PUBLIC = [
  '/login',
  '/forgot-password',
  '/activate',
  '/reset-password',
  '/ruta-que-no-existe',
]
const VIEWPORTS = (process.env.VIEWPORTS ?? 'desktop,mobile').split(',')
const ONLY = process.env.ROLES?.split(',')
const results = []
const problems = []
let clicked = 0

const CONTROLS =
  'button, [role="button"], a[href], summary, [role="tab"], [role="menuitem"], [role="switch"], input[type="checkbox"], input[type="radio"], select'
/** Controles visibles, con un nombre estable para volver a encontrarlos. */
async function controls(page, scope) {
  return page.evaluate(
    ({ selector, scope }) => {
      const root = scope
        ? [
            ...document.querySelectorAll(
              '[role="dialog"],[role="alertdialog"],dialog[open]',
            ),
          ]
            .filter((d) => d.getClientRects().length)
            .at(-1)
        : document
      if (!root) return []
      const seen = {}
      const list = []
      for (const el of root.querySelectorAll(selector)) {
        if (!el.getClientRects().length) continue
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') continue
        // El menú principal se recorre visitando cada pantalla.
        if (
          !scope &&
          el.closest(
            'nav[aria-label="Navegación principal"], .bottom-nav, .sidebar',
          )
        )
          continue
        if (
          !scope &&
          el.closest('[role="dialog"],[role="alertdialog"],dialog[open]')
        )
          continue
        const name = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.getAttribute('title') ||
          el.value ||
          el.getAttribute('name') ||
          el.tagName
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
        const key = `${el.tagName.toLowerCase()}|${name}`
        seen[key] = (seen[key] ?? -1) + 1
        const disabled =
          el.disabled || el.getAttribute('aria-disabled') === 'true'
        const reason = disabled
          ? el.getAttribute('title') ||
            (el.getAttribute('aria-describedby') &&
              document.getElementById(el.getAttribute('aria-describedby'))
                ?.innerText) ||
            ''
          : ''
        list.push({
          key,
          nth: seen[key],
          name,
          tag: el.tagName.toLowerCase(),
          disabled,
          reason: reason.slice(0, 120),
          href: el.getAttribute('href'),
        })
      }
      return list
    },
    { selector: CONTROLS, scope },
  )
}
async function find(page, control, scope) {
  return page.evaluateHandle(
    ({ selector, control, scope }) => {
      const root = scope
        ? [
            ...document.querySelectorAll(
              '[role="dialog"],[role="alertdialog"],dialog[open]',
            ),
          ]
            .filter((d) => d.getClientRects().length)
            .at(-1)
        : document
      if (!root) return null
      let count = -1
      for (const el of root.querySelectorAll(selector)) {
        if (!el.getClientRects().length) continue
        if (
          !scope &&
          el.closest(
            'nav[aria-label="Navegación principal"], .bottom-nav, .sidebar',
          )
        )
          continue
        if (
          !scope &&
          el.closest('[role="dialog"],[role="alertdialog"],dialog[open]')
        )
          continue
        const name = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.getAttribute('title') ||
          el.value ||
          el.getAttribute('name') ||
          el.tagName
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
        if (
          `${el.tagName.toLowerCase()}|${name}` === control.key &&
          ++count === control.nth
        )
          return el
      }
      return null
    },
    { selector: CONTROLS, control, scope },
  )
}
async function state(page) {
  return page.evaluate(() => {
    const text = document.body.innerText
    let hash = 0
    for (let i = 0; i < text.length; i++)
      hash = (hash * 31 + text.charCodeAt(i)) | 0
    const attrs = [
      ...document.querySelectorAll(
        '[aria-expanded],[aria-pressed],[aria-selected],[aria-checked],input,select,textarea',
      ),
    ]
      .map(
        (el) =>
          `${el.getAttribute('aria-expanded')}${el.getAttribute('aria-pressed')}${el.getAttribute('aria-selected')}${el.getAttribute('aria-checked')}${el.value ?? ''}${el.checked ?? ''}`,
      )
      .join('|')
    return {
      url: location.pathname + location.search + location.hash,
      text: hash,
      attrs,
      dialogs: document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"],dialog[open]',
      ).length,
      focus: document.activeElement?.outerHTML.slice(0, 80),
      prints: window.__audit_prints ?? 0,
      scroll: window.scrollY,
    }
  })
}
const tally = () => ({ ...events, errors: events.errors.length })
function describe(before, after, counters, now) {
  const effects = []
  if (before.url !== after.url) effects.push(`va a ${after.url}`)
  if (after.dialogs > before.dialogs) effects.push('abre un diálogo')
  if (after.dialogs < before.dialogs) effects.push('cierra un diálogo')
  if (after.prints > before.prints) effects.push('imprime')
  if (now.downloads > counters.downloads) effects.push('descarga')
  if (now.popups > counters.popups) effects.push('abre otra pestaña')
  if (now.files > counters.files) effects.push('pide un archivo')
  if (!effects.length && before.text !== after.text)
    effects.push('cambia la pantalla')
  if (!effects.length && before.attrs !== after.attrs)
    effects.push('cambia un estado')
  if (!effects.length && before.focus !== after.focus)
    effects.push('mueve el foco')
  if (!effects.length && before.scroll !== after.scroll)
    effects.push('desplaza')
  return effects
}
async function fresh(page, route, user) {
  await base.restore()
  if (
    new URL(page.url()).pathname.startsWith('/login') ||
    page.url() === 'about:blank'
  )
    await login(page, user)
  // Otra pantalla primero para que la de la prueba se monte desde cero.
  await go(page, route === '/account' ? '/' : '/account')
  await go(page, route)
  await page.keyboard.press('Escape').catch(() => {})
}
async function press(page, control, scope) {
  const handle = await find(page, control, scope)
  const element = handle.asElement()
  if (!element) return 'no se volvió a encontrar'
  if (control.tag === 'select') {
    const options = await element.evaluate((el) =>
      [...el.options].map((o) => o.value),
    )
    const current = await element.evaluate((el) => el.value)
    const next = options.find((value) => value !== current)
    if (next === undefined) return 'lista con una sola opción'
    await element.selectOption(next)
    return null
  }
  // Los enlaces «Saltar al contenido» sólo aparecen con el teclado.
  if (/^Saltar al/.test(control.name)) {
    await element.focus()
    await page.keyboard.press('Enter')
    return null
  }
  await element.scrollIntoViewIfNeeded().catch(() => {})
  try {
    await element.click({ timeout: 3000 })
  } catch (error) {
    // Un control tapado por otro no se puede pulsar: eso es un hallazgo.
    return `no se pudo pulsar: ${error.message.split('\n')[0]}`
  }
  return null
}

async function crawl(page, user, role, route, viewport) {
  await fresh(page, route, user)
  const broken = await brokenScreen(page)
  if (broken)
    problems.push({
      viewport,
      role,
      route,
      control: '(al abrir)',
      problem: broken,
    })
  const list = await controls(page, false)
  for (const control of list) {
    if (control.disabled) {
      results.push({
        viewport,
        role,
        route,
        control: control.name,
        effect: `deshabilitado${control.reason ? `: ${control.reason}` : ''}`,
      })
      continue
    }
    await fresh(page, route, user)
    const errorsBefore = events.errors.length
    const counters = tally()
    const before = await state(page)
    if (process.env.DEBUG) console.log('    ·', control.name)
    const failure = await press(page, control, false)
    clicked++
    await settle(page, 4000)
    await page.waitForTimeout(250)
    const after = await state(page)
    const effects = failure ? [] : describe(before, after, counters, tally())
    const broken = await brokenScreen(page)
    const newErrors = events.errors.slice(errorsBefore)
    results.push({
      viewport,
      role,
      route,
      control: control.name,
      effect: failure ?? (effects.join(', ') || 'SIN EFECTO'),
    })
    if (failure && failure !== 'lista con una sola opción')
      problems.push({
        viewport,
        role,
        route,
        control: control.name,
        problem: failure,
      })
    if (broken)
      problems.push({
        viewport,
        role,
        route,
        control: control.name,
        problem: broken,
      })
    for (const error of newErrors)
      problems.push({
        viewport,
        role,
        route,
        control: control.name,
        problem: error,
      })
    if (!failure && !effects.length && !control.href?.startsWith('#'))
      problems.push({
        viewport,
        role,
        route,
        control: control.name,
        problem: 'el botón no hace nada visible',
      })
    // Segundo nivel: los botones del diálogo que se abrió.
    if (after.dialogs > before.dialogs && after.url === before.url) {
      const inner = await controls(page, true)
      for (const child of inner) {
        if (child.disabled) {
          results.push({
            viewport,
            role,
            route,
            control: `${control.name} › ${child.name}`,
            effect: `deshabilitado${child.reason ? `: ${child.reason}` : ''}`,
          })
          continue
        }
        await fresh(page, route, user)
        if (await press(page, control, false)) continue
        await settle(page, 4000)
        const e0 = events.errors.length
        const c0 = tally()
        const b0 = await state(page)
        if (process.env.DEBUG)
          console.log('    ··', control.name, '›', child.name)
        const fail = await press(page, child, true)
        clicked++
        await settle(page, 4000)
        await page.waitForTimeout(250)
        const a0 = await state(page)
        const eff = fail ? [] : describe(b0, a0, c0, tally())
        const br = await brokenScreen(page)
        results.push({
          viewport,
          role,
          route,
          control: `${control.name} › ${child.name}`,
          effect: fail ?? (eff.join(', ') || 'SIN EFECTO'),
        })
        if (fail && fail !== 'lista con una sola opción')
          problems.push({
            viewport,
            role,
            route,
            control: `${control.name} › ${child.name}`,
            problem: fail,
          })
        if (br)
          problems.push({
            viewport,
            role,
            route,
            control: `${control.name} › ${child.name}`,
            problem: br,
          })
        for (const error of events.errors.slice(e0))
          problems.push({
            viewport,
            role,
            route,
            control: `${control.name} › ${child.name}`,
            problem: error,
          })
        if (!fail && !eff.length)
          problems.push({
            viewport,
            role,
            route,
            control: `${control.name} › ${child.name}`,
            problem: 'el botón no hace nada visible',
          })
      }
    }
  }
  // El menú principal: cada enlace lleva a su pantalla sin errores.
  process.stdout.write(
    `  ${viewport} · ${role} · ${route}: ${list.length} controles\n`,
  )
}

try {
  for (const viewport of VIEWPORTS) {
    const size =
      viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 }
    for (const [role, routes] of Object.entries(ROUTES)) {
      if (ONLY && !ONLY.includes(role)) continue
      const { context, page } = await open(size, viewport === 'mobile')
      await login(page, USERS[role])
      for (const route of routes)
        if (
          !process.env.ONLY_ROUTES ||
          process.env.ONLY_ROUTES.split(',').includes(route)
        )
          await crawl(page, USERS[role], role, route, viewport)
      await context.close()
    }
    // Pantallas públicas, sin sesión.
    const { context, page } = await open(size, viewport === 'mobile')
    for (const route of PUBLIC) {
      await page.goto(`${audit.origin}${route}`)
      await settle(page)
      const broken = await brokenScreen(page)
      if (broken)
        problems.push({
          viewport,
          role: 'sin sesión',
          route,
          control: '(al abrir)',
          problem: broken,
        })
      for (const control of await controls(page, false)) {
        if (control.disabled) continue
        await page.goto(`${audit.origin}${route}`)
        await settle(page)
        const e0 = events.errors.length
        const c0 = tally()
        const b0 = await state(page)
        const fail = await press(page, control, false)
        clicked++
        await settle(page, 4000)
        const a0 = await state(page)
        const eff = fail ? [] : describe(b0, a0, c0, tally())
        results.push({
          viewport,
          role: 'sin sesión',
          route,
          control: control.name,
          effect: fail ?? (eff.join(', ') || 'SIN EFECTO'),
        })
        for (const error of events.errors.slice(e0))
          problems.push({
            viewport,
            role: 'sin sesión',
            route,
            control: control.name,
            problem: error,
          })
        const br = await brokenScreen(page)
        if (br)
          problems.push({
            viewport,
            role: 'sin sesión',
            route,
            control: control.name,
            problem: br,
          })
        if (!fail && !eff.length)
          problems.push({
            viewport,
            role: 'sin sesión',
            route,
            control: control.name,
            problem: 'el botón no hace nada visible',
          })
      }
      process.stdout.write(`  ${viewport} · sin sesión · ${route}\n`)
    }
    await context.close()
  }
} catch (error) {
  console.log('ERROR DEL RECORRIDO:', error.stack)
} finally {
  mkdirSync('output/audit', { recursive: true })
  writeFileSync(
    process.env.OUT ?? 'output/audit/buttons.json',
    JSON.stringify(
      {
        clicked,
        results,
        problems,
        unknown: [...audit.api.unknown],
        apiFailures: audit.api.failures,
      },
      null,
      2,
    ),
  )
  console.log(
    `\n${clicked} controles pulsados; ${results.filter((r) => r.effect.startsWith('deshabilitado')).length} deshabilitados; ${problems.length} observaciones.`,
  )
  for (const p of problems.slice(0, 80))
    console.log(
      `✘ [${p.viewport}/${p.role}] ${p.route} · ${p.control}: ${p.problem}`,
    )
  if (audit.api.unknown.size)
    console.log(
      'API simulada sin respuesta para:',
      [...audit.api.unknown].join('; '),
    )
  if (audit.api.failures.length)
    console.log(
      'Errores internos de la API simulada:',
      audit.api.failures.slice(0, 10).join('\n'),
    )
  await audit.stop()
  process.exit(0)
}
