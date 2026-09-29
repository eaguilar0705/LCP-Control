// Runs the real recovery UI against a simulated Supabase. No emails or live
// passwords are sent or changed; every external request is intercepted.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
const BASE = 'http://127.0.0.1:5178'
const API = 'https://recovery.supabase.invalid'
Object.assign(process.env, {
  VITE_DATA_MODE: 'supabase',
  VITE_SUPABASE_URL: API,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_recovery_test',
  VITE_AUTH_REDIRECT_URL: `${BASE}/auth/callback`,
})
const user = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'recovery@example.test',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.test-signature`
const server = await createServer({
  mode: 'test',
  cacheDir: 'output/cache/vite-recovery',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  })
  const context = await browser.newContext()
  let requests = 0,
    updated = false
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.origin === BASE) return route.continue()
    if (url.origin !== API) return route.abort()
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers })
    const json = (body) =>
      route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    if (url.pathname === '/auth/v1/recover') {
      requests++
      assert.equal(request.postDataJSON().email, user.email)
      assert.equal(
        url.searchParams.get('redirect_to'),
        `${BASE}/auth/callback?type=recovery`,
      )
      return json({})
    }
    if (url.pathname === '/auth/v1/user') {
      if (request.method() === 'PUT') {
        assert.equal(request.postDataJSON().password, 'New-test-password-2026!')
        updated = true
      }
      return json(user)
    }
    if (url.pathname === '/rest/v1/staff_members')
      return json([{ role: 'operator', active: true }])
    return json([])
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/login`)
  await page.getByRole('link', { name: 'Olvidé mi contraseña' }).click()
  await page.getByLabel('Correo electrónico').fill(user.email)
  await page.getByRole('button', { name: 'Enviar enlace', exact: true }).click()
  await page
    .getByText('Si el correo corresponde a una cuenta', { exact: false })
    .waitFor()
  assert.equal(requests, 1)
  assert.equal(
    await page.getByRole('button', { name: /Reenviar en/ }).isEnabled(),
    false,
  )
  await page.goto(
    `${BASE}/auth/callback?type=recovery#access_token=${access}&refresh_token=fake-recovery&type=recovery`,
  )
  await page.getByLabel('Nueva contraseña', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/reset-password')
  assert.equal(new URL(page.url()).hash, '')
  assert.equal(new URL(page.url()).search, '')
  await page
    .getByLabel('Nueva contraseña', { exact: true })
    .fill('New-test-password-2026!')
  await page
    .getByLabel('Repetir contraseña', { exact: true })
    .fill('New-test-password-2026!')
  await page.getByRole('button', { name: 'Guardar contraseña' }).click()
  await page
    .getByText('Tu contraseña se actualizó.', { exact: false })
    .waitFor()
  assert.equal(updated, true)
  await page.goto(
    `${BASE}/auth/callback#error=access_denied&error_code=otp_expired`,
  )
  await page
    .getByText('El enlace venció o ya se usó.', { exact: false })
    .waitFor()
  assert.equal(
    await page
      .getByRole('link', { name: 'Recuperar contraseña' })
      .getAttribute('href'),
    '/forgot-password',
  )
  assert.deepEqual(errors, [])
  console.log(
    'Recovery passed: email request, cooldown, callback, token cleanup, password update and expired link. No live Supabase accessed.',
  )
} finally {
  await browser?.close()
  await server.close()
}
