// Build-time guards used by vite.config.ts; the app never imports this module.
// Findings report the kind of secret, never its value.

const secretPatterns: [string, RegExp][] = [
  ['clave secreta de Supabase', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['clave privada PEM', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['clave secreta de Stripe', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['token de GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['clave de acceso de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token de Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['clave de API de IA', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  [
    'cadena de conexión con contraseña',
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/@'"`]+:[^\s@'"`]+@/,
  ],
]
const jwtPattern =
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

function jwtRole(token: string): unknown {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    return (JSON.parse(atob(padded)) as { role?: unknown }).role
  } catch {
    return undefined
  }
}

export function findSecrets(text: string): string[] {
  const found = secretPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name)
  // The legacy anon key is public by design; any other token is a credential.
  for (const [token] of text.matchAll(jwtPattern))
    if (jwtRole(token) !== 'anon') {
      found.push('JWT distinto de la clave anon')
      break
    }
  return found
}

const secretName = /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD/i

// Vite embeds every VITE_* variable in the bundle, so a secret name or value
// there would ship to every visitor.
export function exposedSecretEnv(env: Record<string, unknown>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        name.startsWith('VITE_') &&
        (secretName.test(name) ||
          (typeof value === 'string' && findSecrets(value).length > 0)),
    )
    .map(([name]) => name)
}

// `undefined` is Vite's default (localhost); `true` comes from a bare `--host`
// and listens on every interface.
export function isLoopbackHost(host: string | boolean | undefined): boolean {
  if (host === undefined) return true
  if (typeof host !== 'string') return false
  return (
    host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}
