import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
)
// Fixed generated outputs only. Dependencies, configuration and business data
// never belong in this list. Stop preview/tests before running this command.
for (const name of [
  'output/dist',
  'output/test-results',
  'output/playwright-report',
  'output/coverage',
  'output/cache',
  // Ubicaciones anteriores a la carpeta output/
  'dist',
  'test-results',
  'playwright-report',
  'coverage',
  'tsconfig.tsbuildinfo',
]) {
  const target = resolve(root, name)
  const within = relative(root, target)
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error(`Ruta de limpieza no válida: ${name}`)
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || (await realpath(target)) !== target)
      throw new Error(`No se limpia un enlace: ${name}`)
    await rm(target, { recursive: info.isDirectory(), force: false })
    console.log(`Eliminado: ${name} (generado; se puede regenerar)`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
