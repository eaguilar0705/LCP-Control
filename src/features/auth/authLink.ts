import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * Lo que puede traer la dirección a la que Supabase Auth devuelve a la persona
 * después de abrir un enlace de correo (confirmación, recuperación, cambio de
 * correo). Supabase usa tres formatos según el flujo y la plantilla del correo:
 *
 * - `#access_token=…&refresh_token=…` flujo implícito (predeterminado de supabase-js).
 * - `?code=…` flujo PKCE: sólo se puede canjear en el mismo navegador del registro.
 * - `?token_hash=…&type=…` plantilla propia que enlaza directo a la aplicación;
 *   funciona desde cualquier dispositivo y no la consumen los escáneres de correo.
 *
 * Cuando el enlace venció o ya se usó llega `error`, `error_code` y
 * `error_description`, en el fragmento o en la consulta.
 */
export type AuthLink =
  | { kind: 'code'; code: string; type: string | null }
  | { kind: 'token_hash'; tokenHash: string; type: EmailOtpType }
  | {
      kind: 'tokens'
      accessToken: string
      refreshToken: string
      type: string | null
    }
  | { kind: 'error'; code: string | null; description: string | null }
  /** Aviso sin sesión: el primer enlace de un cambio de correo seguro. */
  | { kind: 'notice'; message: string }

export const AUTH_CALLBACK_PATH = '/auth/callback'

const otpTypes: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]

function params(value: string, prefix: '?' | '#') {
  return new URLSearchParams(value.startsWith(prefix) ? value.slice(1) : value)
}

export function parseAuthLink(search: string, hash: string): AuthLink | null {
  const query = params(search, '?')
  const fragment = params(hash, '#')
  const error =
    fragment.get('error_code') ??
    query.get('error_code') ??
    fragment.get('error') ??
    query.get('error')
  if (error)
    return {
      kind: 'error',
      code: error,
      description:
        fragment.get('error_description') ?? query.get('error_description'),
    }
  const accessToken = fragment.get('access_token')
  const refreshToken = fragment.get('refresh_token')
  if (accessToken && refreshToken)
    return {
      kind: 'tokens',
      accessToken,
      refreshToken,
      type: fragment.get('type'),
    }
  const tokenHash = query.get('token_hash')
  const type = query.get('type') as EmailOtpType | null
  if (tokenHash && type && otpTypes.includes(type))
    return { kind: 'token_hash', tokenHash, type }
  const code = query.get('code')
  if (code) return { kind: 'code', code, type: query.get('type') }
  const message = fragment.get('message')
  if (message) return { kind: 'notice', message }
  return null
}

/**
 * ¿La dirección actual trae datos de un enlace de Supabase Auth? `?code=` sólo
 * cuenta en las rutas a las que Supabase puede devolver (inicio o acceso), para
 * no confundirlo con un parámetro propio de otra pantalla.
 */
export function hasAuthLink(pathname: string, search: string, hash: string) {
  const link = parseAuthLink(search, hash)
  if (!link) return false
  if (link.kind !== 'code') return true
  return ['/', '/login', AUTH_CALLBACK_PATH].includes(pathname)
}

export function authLinkErrorMessage(code: string | null) {
  switch (code) {
    case 'otp_expired':
    case 'email_link_invalid':
    case 'access_denied':
      return 'El enlace venció o ya se usó. Si ya lo habías abierto, tu correo puede estar confirmado: intenta iniciar sesión. Si no, solicita un correo nuevo desde «Activar mi cuenta».'
    case 'bad_code_verifier':
    case 'flow_state_not_found':
    case 'flow_state_expired':
      return 'Abre el enlace en el mismo navegador donde creaste tu acceso, o solicita un correo nuevo desde «Activar mi cuenta».'
    case 'user_not_found':
      return 'La cuenta de este enlace ya no existe. Solicita acceso al administrador.'
    default:
      return 'No pudimos confirmar el enlace. Solicita un correo nuevo desde «Activar mi cuenta» o inicia sesión si ya confirmaste tu correo.'
  }
}

/** Adonde ir después de canjear el enlace: la recuperación termina en Mi cuenta. */
export function destinationAfterLink(link: AuthLink) {
  return 'type' in link && link.type === 'recovery' ? '/account' : '/'
}
