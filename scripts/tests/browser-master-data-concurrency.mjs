import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin, operator } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
// La URL publicada también se puede inspeccionar: todas las solicitudes a
// Supabase se interceptan en browserDatabase y usan PostgreSQL desechable.
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/enterprise-master-data'
await mkdir(output, { recursive: true })
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (promise, pattern) => {
  await assert.rejects(promise, pattern)
  checks++
}
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const db = fixture.db
    const errors = []
    const lostResponseRequests = []
    page.on('pageerror', (error) => errors.push(error.message))
    const business = async () =>
      (
        await db.query(`select jsonb_build_object('name',name,'legalName',legal_name,
        'taxId',tax_id,'address',address,'phone',phone,'email',email,'branch',branch,
        'billingDetails',billing_details) profile from public.business_settings where id=true`)
      ).rows[0].profile
    const saveBusiness = (payload, expected) =>
      db.query(
        'select public.save_business_profile_checked($1::jsonb,$2::jsonb)',
        [JSON.stringify(payload), JSON.stringify(expected)],
      )
    const staff = async (email) =>
      (
        await db.query(
          'select to_jsonb(s) account from public.list_staff_accounts() s where s.email=$1',
          [email],
        )
      ).rows[0]?.account ?? null
    const saveStaff = (record, expected) =>
      db.query(
        'select public.save_staff_account_checked($1,$2,$3,$4,$5::jsonb)',
        [
          record.email,
          record.display_name,
          record.role,
          record.active,
          expected === null ? null : JSON.stringify(expected),
        ],
      )
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const healthy = async () => {
      equal(errors, [], 'sin errores del navegador')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'sin desbordamiento horizontal',
      )
    }
    const clearConflict = (pattern) => {
      equal(fixture.failures.length, 1, 'un único rechazo esperado')
      assert.match(fixture.failures[0], pattern)
      checks++
      fixture.failures.length = 0
    }
    try {
      // Los clientes antiguos no pueden saltarse la protección autoritativa.
      const originalBusiness = await business()
      await rejects(
        db.query('select public.save_business_profile($1::jsonb)', [
          JSON.stringify({ ...originalBusiness, phone: '00000000' }),
        ]),
        /Actualiza la página/,
      )
      await rejects(
        db.query(
          "select public.save_business_settings('Viejo','Vieja','00000000')",
        ),
        /Actualiza la página/,
      )
      await rejects(
        db.query('select private.save_business_profile($1::jsonb)', [
          JSON.stringify(originalBusiness),
        ]),
        /permission denied|insufficient_privilege/,
      )
      equal(await business(), originalBusiness)
      await identity(db, operator)
      await rejects(
        saveBusiness(originalBusiness, originalBusiness),
        /permission denied|insufficient_privilege/,
      )
      await rejects(
        saveStaff(
          {
            email: 'denied@example.test',
            display_name: 'No',
            role: 'operator',
            active: true,
          },
          null,
        ),
        /permission denied|insufficient_privilege/,
      )
      await identity(db, admin)

      const email = 'colaborador@example.test'
      const originalStaff = {
        email,
        display_name: 'Colaborador',
        role: 'admin',
        active: true,
      }
      await saveStaff(originalStaff, null)
      const pendingSnapshot = await staff(email)
      await rejects(
        db.query('select public.save_staff_account($1,$2,$3,$4)', [
          email,
          'Cliente antiguo',
          'admin',
          true,
        ]),
        /Actualiza la página/,
      )
      equal(await staff(email), pendingSnapshot)

      await page.goto(base + '/login')
      await page
        .getByLabel('Correo electrónico', { exact: true })
        .fill('auditoria@example.test')
      await page
        .getByLabel('Contraseña', { exact: true })
        .fill('Local-test-password!')
      await page
        .getByRole('button', { name: 'Iniciar sesión', exact: true })
        .click()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()

      // Un teléfono que cambió en otra sesión no se restaura al editar Dirección.
      await navigate('/settings')
      await page.getByLabel('Teléfono', { exact: true }).waitFor()
      equal(
        await page.getByLabel('Teléfono', { exact: true }).inputValue(),
        '88888888',
      )
      await saveBusiness(
        { ...originalBusiness, phone: '77776666' },
        originalBusiness,
      )
      await page
        .getByLabel('Dirección', { exact: true })
        .fill('Dirección escrita sin guardar')
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByRole('alert')
        .filter({
          hasText: 'Otro administrador modificó los datos del negocio',
        })
        .waitFor()
      clearConflict(/Otro administrador modificó los datos del negocio/)
      equal((await business()).phone, '77776666')
      equal((await business()).address, 'Managua')
      equal(
        await page.getByLabel('Dirección', { exact: true }).inputValue(),
        'Dirección escrita sin guardar',
      )
      await page
        .getByRole('button', { name: 'Actualizar datos', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await page.getByLabel('Dirección', { exact: true }).inputValue(),
        'Dirección escrita sin guardar',
        'cancelar recarga conserva la edición',
      )
      await healthy()
      await page.screenshot({
        path: `${output}/conflicto-negocio-${width}.png`,
        fullPage: true,
      })
      await page
        .getByRole('button', { name: 'Actualizar datos', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cargar datos actuales', exact: true })
        .click()
      await page.getByLabel('Teléfono', { exact: true }).waitFor()
      equal(
        await page.getByLabel('Teléfono', { exact: true }).inputValue(),
        '77776666',
      )
      equal(
        await page.getByLabel('Dirección', { exact: true }).inputValue(),
        'Managua',
      )
      await page
        .getByLabel('Dirección', { exact: true })
        .fill('Dirección corregida con datos actuales')
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByText('Datos del negocio guardados.', { exact: true })
        .waitFor()
      equal((await business()).phone, '77776666')
      equal(
        (await business()).address,
        'Dirección corregida con datos actuales',
      )

      // Un guardado confirmado cuya respuesta se pierde admite reintento exacto.
      await page.getByLabel('Teléfono', { exact: true }).waitFor()
      await page.getByLabel('Teléfono', { exact: true }).fill('55554444')
      let businessLost = false
      let businessMayReply = false
      let businessOriginalRequest
      const loseBusiness = async (route) => {
        const body = route.request().postDataJSON()
        lostResponseRequests.push({
          operation: 'business',
          mayReply: businessMayReply,
          body,
        })
        if (businessLost) {
          assert.deepEqual(
            body,
            businessOriginalRequest,
            'el reintento conserva la solicitud de Negocio',
          )
          if (businessMayReply) return route.fallback()
        } else {
          businessLost = true
          businessOriginalRequest = body
          await saveBusiness(body.p_payload, body.p_expected)
        }
        // Se mantiene la respuesta perdida hasta el reintento humano, aunque
        // el transporte repita una petición internamente.
        await route.abort('failed')
      }
      await page.route(
        '**/rest/v1/rpc/save_business_profile_checked',
        loseBusiness,
      )
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page.getByRole('alert').waitFor()
      equal((await business()).phone, '55554444')
      equal(
        await page.getByLabel('Teléfono', { exact: true }).inputValue(),
        '55554444',
      )
      businessMayReply = true
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByText('Datos del negocio guardados.', { exact: true })
        .waitFor()
      equal(fixture.failures, [])
      await page.unroute(
        '**/rest/v1/rpc/save_business_profile_checked',
        loseBusiness,
      )

      // Cambiar sólo el nombre en una ficha vieja no reactiva ni eleva permisos.
      await navigate('/staff')
      const card = page.locator('.staff-card').filter({ hasText: email })
      await card
        .getByRole('button', { name: 'Editar permisos', exact: true })
        .click()
      await saveStaff(
        { ...pendingSnapshot, role: 'viewer', active: false },
        pendingSnapshot,
      )
      await page
        .getByLabel('Nombre', { exact: true })
        .fill('Nombre escrito sin guardar')
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Otro administrador modificó o activó esta cuenta' })
        .waitFor()
      clearConflict(/Otro administrador modificó o activó esta cuenta/)
      equal((await staff(email)).role, 'viewer')
      equal((await staff(email)).active, false)
      equal((await staff(email)).display_name, 'Colaborador')
      equal(
        await page.getByLabel('Nombre', { exact: true }).inputValue(),
        'Nombre escrito sin guardar',
      )
      await page
        .getByRole('button', { name: 'Actualizar usuario', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await page.getByLabel('Nombre', { exact: true }).inputValue(),
        'Nombre escrito sin guardar',
      )
      await healthy()
      await page.screenshot({
        path: `${output}/conflicto-usuario-${width}.png`,
        fullPage: true,
      })
      await page
        .getByRole('button', { name: 'Actualizar usuario', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cargar datos actuales', exact: true })
        .click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      equal(
        await page.getByLabel('Nombre', { exact: true }).inputValue(),
        'Colaborador',
      )
      equal(
        await page.getByLabel('Permisos', { exact: true }).inputValue(),
        'viewer',
      )
      equal(
        await page.getByLabel('Estado', { exact: true }).inputValue(),
        'false',
      )
      await page
        .getByLabel('Nombre', { exact: true })
        .fill('Nombre corregido sin reactivar')
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByText(
          'Acceso guardado. Las cuentas nuevas se activan desde la pantalla de acceso.',
          { exact: true },
        )
        .waitFor()
      equal((await staff(email)).role, 'viewer')
      equal((await staff(email)).active, false)
      equal((await staff(email)).display_name, 'Nombre corregido sin reactivar')

      // Alta con respuesta perdida: el reintento reconoce exactamente la cuenta.
      await page
        .getByRole('button', { name: 'Autorizar correo', exact: true })
        .click()
      // openStaffForm lleva el foco al correo en requestAnimationFrame. Esperar
      // su render evita que el foco cambie durante la escritura automatizada.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            globalThis.requestAnimationFrame(() =>
              globalThis.requestAnimationFrame(resolve),
            )
          }),
      )
      equal(
        await page
          .getByLabel('Correo', { exact: true })
          .evaluate((input) => input === globalThis.document.activeElement),
        true,
        'el autofocus de la autorización ya terminó',
      )
      await page
        .getByLabel('Correo', { exact: true })
        .fill('respuesta-perdida@example.test')
      await page
        .getByLabel('Nombre', { exact: true })
        .fill('Acceso por confirmar')
      equal(
        await page.getByLabel('Correo', { exact: true }).inputValue(),
        'respuesta-perdida@example.test',
      )
      equal(
        await page.getByLabel('Nombre', { exact: true }).inputValue(),
        'Acceso por confirmar',
      )
      equal(
        await page
          .getByLabel('Correo', { exact: true })
          .evaluate((input) => input.form.checkValidity()),
        true,
        'el formulario es válido antes de simular la pérdida de respuesta',
      )
      let staffLost = false
      let staffMayReply = false
      let staffOriginalRequest
      const loseStaff = async (route) => {
        const body = route.request().postDataJSON()
        lostResponseRequests.push({
          operation: 'staff',
          mayReply: staffMayReply,
          body,
        })
        if (staffLost) {
          assert.deepEqual(
            body,
            staffOriginalRequest,
            'el reintento conserva la solicitud de Usuarios',
          )
          if (staffMayReply) return route.fallback()
        } else {
          staffLost = true
          staffOriginalRequest = body
          await db.query(
            'select public.save_staff_account_checked($1,$2,$3,$4,$5::jsonb)',
            [
              body.p_email,
              body.p_name,
              body.p_role,
              body.p_active,
              body.p_expected === null ? null : JSON.stringify(body.p_expected),
            ],
          )
        }
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/save_staff_account_checked', loseStaff)
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page.getByRole('alert').waitFor()
      equal(
        (await staff('respuesta-perdida@example.test')).display_name,
        'Acceso por confirmar',
      )
      equal(
        await page.getByLabel('Nombre', { exact: true }).inputValue(),
        'Acceso por confirmar',
      )
      staffMayReply = true
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
      await page
        .getByText(
          'Acceso guardado. Las cuentas nuevas se activan desde la pantalla de acceso.',
          { exact: true },
        )
        .waitFor()
      equal(
        (
          await db.query(
            "select count(*)::int n from public.list_staff_accounts() where email='respuesta-perdida@example.test'",
          )
        ).rows[0].n,
        1,
      )
      await page.unroute('**/rest/v1/rpc/save_staff_account_checked', loseStaff)

      // Una invitación activada mientras se editaba también genera conflicto.
      const activationEmail = 'activada@example.test'
      await saveStaff(
        {
          email: activationEmail,
          display_name: 'Activación',
          role: 'operator',
          active: true,
        },
        null,
      )
      const beforeActivation = await staff(activationEmail)
      await db.exec('reset role')
      await db.query('insert into auth.users(id,email) values($1,$2)', [
        crypto.randomUUID(),
        activationEmail,
      ])
      await identity(db, admin)
      await rejects(
        saveStaff(
          { ...beforeActivation, display_name: 'Ficha anterior' },
          beforeActivation,
        ),
        /modificó o activó/,
      )
      equal((await staff(activationEmail)).registered, true)
      equal((await staff(activationEmail)).display_name, 'Activación')
      const registeredSnapshot = await staff(activationEmail)
      await saveStaff(
        { ...registeredSnapshot, role: 'viewer', active: false },
        registeredSnapshot,
      )
      await rejects(
        saveStaff(
          { ...registeredSnapshot, display_name: 'Nombre de una ficha vieja' },
          registeredSnapshot,
        ),
        /modificó o activó/,
      )
      equal((await staff(activationEmail)).role, 'viewer')
      equal((await staff(activationEmail)).active, false)
      equal((await staff(activationEmail)).display_name, 'Activación')
      const removedSnapshot = await staff(activationEmail)
      await db.query('select public.delete_staff_account($1,$2,$3)', [
        activationEmail,
        removedSnapshot.user_id,
        removedSnapshot.role,
      ])
      await rejects(
        saveStaff(
          {
            ...removedSnapshot,
            display_name: 'No resucitar una cuenta borrada',
          },
          removedSnapshot,
        ),
        /modificó o activó/,
      )
      equal(
        await staff(activationEmail),
        null,
        'una ficha obsoleta no recrea una cuenta borrada',
      )
      equal(fixture.failures, [])
      await healthy()
      results.push({
        width,
        status: 'PASS',
        business: await business(),
        collaborator: await staff(email),
        responseLostStaff: await staff('respuesta-perdida@example.test'),
        lostResponseRequests,
      })
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            error: error.message,
            url: page.url(),
            lostResponseRequests,
            errors,
            databaseErrors: fixture.failures,
            forms: await page.locator('form').evaluateAll((forms) =>
              forms.map((form) => ({
                valid: form.checkValidity(),
                fields: Array.from(form.elements).map((field) => ({
                  tag: field.tagName,
                  name: field.getAttribute('name'),
                  value: field.value,
                  validationMessage: field.validationMessage,
                  disabled: field.disabled,
                })),
              })),
            ),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
}
console.log(
  `PASS datos maestros: ${checks} comprobaciones; CAS autoritativo, versiones antiguas seguras, conflicto/recarga, permisos, activación y respuesta perdida en 1440/390/320.`,
)
