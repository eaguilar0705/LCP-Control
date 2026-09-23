// Run from the repository: node scripts/import_product_images.mjs [--apply]
// Uses an administrator's normal session, never a service-role key. No password
// is written to disk. Existing Storage photos are never replaced by this import.
import { createClient } from '@supabase/supabase-js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
try {
  process.loadEnvFile('.env.local')
} catch {
  /* Environment variables also work. */
}
const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
if (!url || !key?.startsWith('sb_publishable_'))
  throw new Error('Configura URL y clave publicable en .env.local.')
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: true },
})
const prompts = createInterface({ input: stdin, output: stdout })
const email = await prompts.question('Correo del administrador: ')
prompts.close()
if (!stdin.isTTY)
  throw new Error('Ejecuta el importador en una terminal interactiva.')
stdout.write('Contraseña (oculta): ')
const password = await new Promise((resolve) => {
  let value = ''
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  const receive = (chunk) => {
    for (const char of chunk) {
      if (char === '\u0003') {
        stdin.setRawMode(false)
        process.exit(130)
      }
      if (char === '\r' || char === '\n') {
        stdin.off('data', receive)
        stdin.setRawMode(false)
        stdin.pause()
        stdout.write('\n')
        resolve(value)
        return
      }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
      else value += char
    }
  }
  stdin.on('data', receive)
})
const { data: auth, error: loginError } = await client.auth.signInWithPassword({
  email,
  password,
})
if (loginError || !auth.user) throw new Error('No se pudo iniciar sesión.')
try {
  const { data: staff, error: staffError } = await client
    .from('staff_members')
    .select('role,active')
    .eq('user_id', auth.user.id)
    .single()
  if (staffError || staff?.role !== 'admin' || !staff.active)
    throw new Error('La cuenta debe ser administradora y estar activa.')
  const { data: rows, error } = await client
    .from('products')
    .select('*,brands(name),product_prices(tier_code,currency,amount)')
    .order('sku')
    .limit(2000)
  if (error)
    throw new Error(
      'No se pudo leer el catálogo. Aplica primero la migración de catálogo e imágenes.',
    )
  let migrated = 0,
    failed = 0,
    missing = 0,
    skipped = 0
  const apply = process.argv.includes('--apply')
  for (const row of rows) {
    if (row.image_path) {
      skipped++
      continue
    }
    // Only the Drive URLs provided in the source catalog are fetched; arbitrary
    // URLs from product data cannot turn this import into a network proxy.
    let source
    try {
      source = new URL(row.image_reference)
    } catch {
      missing++
      continue
    }
    if (source.hostname !== 'drive.google.com') {
      missing++
      continue
    }
    const id =
      /\/d\/([\w-]+)/.exec(source.pathname)?.[1] ??
      source.searchParams.get('id')
    if (!id || !/^[\w-]+$/.test(id)) {
      missing++
      continue
    }
    if (!apply) {
      migrated++
      continue
    }
    await pause(550) // Stay below the per-user catalogue write limit.
    try {
      let response
      try {
        const cached = JSON.parse(
          await readFile(`private-data/image-cache/${id}.json`, 'utf8'),
        )
        response = new Response(Buffer.from(cached.body, 'base64'), {
          headers: { 'content-type': cached.contentType },
        })
      } catch {
        response = await fetch(
          `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1200`,
          { signal: AbortSignal.timeout(30000) },
        )
      }
      if (!response.ok) throw new Error('La foto no está disponible en Drive.')
      const contentType = response.headers.get('content-type')?.split(';')[0]
      const extension = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
      }[contentType]
      if (
        !extension ||
        Number(response.headers.get('content-length') ?? 0) > 5242880
      )
        throw new Error('La respuesta no es una imagen válida de hasta 5 MB.')
      const chunks = []
      let length = 0
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > 5242880) throw new Error('Imagen mayor de 5 MB.')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      const magic =
        extension === 'jpg'
          ? bytes[0] === 255 && bytes[1] === 216
          : extension === 'png'
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP'
      if (!magic)
        throw new Error(
          'El contenido recibido no coincide con el formato de imagen.',
        )
      const digest = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .slice(0, 16)
      const path = `${auth.user.id}/import-${row.id}-${digest}.${extension}`
      const { error: uploadError } = await client.storage
        .from('product-images')
        .upload(path, bytes, {
          contentType,
          cacheControl: '31536000',
          upsert: false,
        })
      if (uploadError && String(uploadError.statusCode) !== '409')
        throw new Error('No se pudo subir la imagen a Storage.')
      const prices = { emprendedor: {}, vip: {}, premium: {} }
      for (const price of row.product_prices)
        prices[price.tier_code][price.currency] = Number(price.amount)
      const { error: saveError } = await client.rpc('save_catalog_product', {
        p_payload: {
          id: row.id,
          revision: row.revision,
          name: row.name,
          brand: row.brands.name,
          size: row.size === null ? null : Number(row.size),
          unit: row.unit,
          category: row.category ?? 'unspecified',
          gender: row.gender ?? 'unspecified',
          manufacturerBarcode: row.barcode ?? '',
          minimumStock: row.minimum_stock,
          active: row.active,
          imagePath: path,
          prices,
        },
      })
      if (saveError)
        throw new Error(
          'No se pudo asociar la foto; el producto puede haber cambiado. Reintenta la importación.',
        )
      migrated++
      stdout.write(`${row.sku}: foto guardada\n`)
    } catch (error) {
      failed++
      stdout.write(
        `${row.sku}: ${error instanceof Error ? error.message : 'Error de importación'}\n`,
      )
    }
  }
  stdout.write(
    `${apply ? 'Guardadas' : 'Por importar'}: ${migrated}. Ya guardadas: ${skipped}. Sin enlace válido: ${missing}. Fallidas: ${failed}.\n`,
  )
  if (!apply) stdout.write('Para copiar las fotos, repite con --apply.\n')
  if (failed) process.exitCode = 1
} finally {
  await client.auth.signOut({ scope: 'local' })
  client.auth.stopAutoRefresh()
}
