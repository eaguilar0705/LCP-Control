export class AppError extends Error {
  constructor(
    public kind:
      | 'network'
      | 'validation'
      | 'unauthorized'
      | 'rate_limited'
      | 'configuration'
      | 'unexpected',
    message: string,
  ) {
    super(message)
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (!navigator.onLine || error instanceof TypeError)
    return 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.'
  return 'No pudimos completar la operación. Inténtalo de nuevo.'
}
/**
 * Los avisos de una validación, uno por campo: la clave es la ruta del dato
 * («name», «prices.vip.USD»), con `prefix` delante. Si un campo tiene varios
 * problemas, se enseña el primero.
 */
export function issuesByField(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  prefix = '',
): Record<string, string> {
  const found: Record<string, string> = {}
  for (const issue of issues) {
    const path = issue.path.map(String).join('.')
    if (!path) continue
    const key = `${prefix}${path}`
    if (!(key in found)) found[key] = issue.message
  }
  return found
}
