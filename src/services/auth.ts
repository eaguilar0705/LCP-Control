import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { AppError } from '../lib/errors'
import { parseRole } from '../lib/permissions'
import type { UserProfile, UserRole } from '../lib/domain'
import {
  AUTH_CALLBACK_PATH,
  authLinkErrorMessage,
  type AuthLink,
} from '../features/auth/authLink'
export interface AuthService {
  getSession(): Promise<UserProfile | null>
  signIn(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  subscribe(callback: (user: UserProfile | null) => void): () => void
}
/**
 * El rol vive únicamente en `staff_members`, la misma tabla que consultan las
 * políticas de PostgreSQL. Leerlo del token abriría una segunda fuente que hay
 * que mantener a mano y que puede contradecir a la base. La política
 * `self_profile` permite a cada cuenta leer su propia fila y ninguna otra.
 */
export async function roleFromDatabase(
  userId: string,
): Promise<UserRole | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('staff_members')
    .select('role,active')
    .eq('user_id', userId)
    .maybeSingle()
  if (error)
    throw new AppError(
      'network',
      'No pudimos comprobar tu autorización. Inténtalo de nuevo.',
    )
  const row = data as { role: string; active: boolean } | null
  return row?.active ? parseRole(row.role) : null
}
export async function profileFromSession(
  session: Session | null,
): Promise<UserProfile | null> {
  return session
    ? {
        id: session.user.id,
        email: session.user.email ?? '',
        role: await roleFromDatabase(session.user.id),
      }
    : null
}
function client() {
  if (!supabase)
    throw new AppError(
      'configuration',
      'Configura Supabase para acceder con tu cuenta. Puedes explorar la demostración.',
    )
  return supabase
}
export const authService: AuthService = {
  async getSession() {
    if (!supabase) return null
    const { data, error } = await supabase.auth.getSession()
    if (error)
      throw new AppError(
        'network',
        'No pudimos restaurar tu sesión. Vuelve a intentarlo.',
      )
    return profileFromSession(data.session)
  },
  async signIn(email, password) {
    const { error } = await client().auth.signInWithPassword({
      email,
      password,
    })
    if (error)
      throw new AppError(
        error.status === 400 ? 'unauthorized' : 'network',
        error.code === 'email_not_confirmed'
          ? 'Tu correo aún no está confirmado. Abre el enlace que te enviamos o solicita uno nuevo desde «Activar mi cuenta».'
          : error.status === 400
            ? 'Correo o contraseña incorrectos, o cuenta no habilitada.'
            : 'No pudimos iniciar sesión. Revisa tu conexión e inténtalo de nuevo.',
      )
  },
  async signOut() {
    const { error } = await client().auth.signOut({ scope: 'local' })
    if (error)
      throw new AppError(
        'network',
        'No pudimos cerrar la sesión. Inténtalo de nuevo.',
      )
  },
  subscribe(callback) {
    if (!supabase) return () => {}
    let active = true
    let version = 0
    let pending: ReturnType<typeof setTimeout> | undefined
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      const eventVersion = ++version
      clearTimeout(pending)
      if (!session) {
        callback(null)
        return
      }
      const publish = (user: UserProfile | null) => {
        if (active && eventVersion === version) callback(user)
      }
      // La consulta se difiere: supabase-js desaconseja llamar al cliente
      // dentro del propio callback de autenticación.
      pending = setTimeout(() => {
        profileFromSession(session)
          .then(publish)
          // Falla cerrado: sin rol comprobado no se concede acceso.
          .catch(() =>
            publish(
              session
                ? {
                    id: session.user.id,
                    email: session.user.email ?? '',
                    role: null,
                  }
                : null,
            ),
          )
      }, 0)
    })
    return () => {
      active = false
      version++
      clearTimeout(pending)
      data.subscription.unsubscribe()
    }
  },
}

/**
 * Dirección a la que Supabase devuelve a la persona después de abrir el enlace
 * del correo. Sin `emailRedirectTo`, Supabase usa la «Site URL» del proyecto,
 * que hoy apunta al equipo de desarrollo (127.0.0.1) y no existe en el
 * teléfono ni en otra computadora. Debe figurar en Authentication → URL
 * Configuration → Redirect URLs; si no, Supabase vuelve a la Site URL.
 * `VITE_AUTH_REDIRECT_URL` fija el dominio publicado cuando el origen actual no
 * es el definitivo.
 */
export function authRedirectUrl(origin = globalThis.location?.origin ?? '') {
  const configured = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim()
  const parsed = configured ? URL.parse(configured) : null
  if (parsed && (parsed.protocol === 'https:' || isLoopback(parsed.hostname)))
    return parsed.href
  return `${origin}${AUTH_CALLBACK_PATH}`
}
function isLoopback(hostname: string) {
  return hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export type SignUpResult = 'confirmation_sent' | 'already_registered'

function signUpError(error: { code?: string; status?: number }) {
  return new AppError(
    'validation',
    error.code === 'email_address_not_authorized'
      ? 'Falta habilitar el envío de correos de acceso para esta dirección. Comunícalo al administrador.'
      : error.code === 'over_email_send_rate_limit' || error.status === 429
        ? 'Se alcanzó el límite temporal de correos. Espera unos minutos antes de intentarlo otra vez.'
        : error.code === 'weak_password'
          ? 'La contraseña es demasiado débil. Usa al menos 12 caracteres combinando letras y números.'
          : error.code === 'user_already_exists'
            ? 'Este correo ya tiene acceso. Inicia sesión.'
            : 'No se pudo activar la cuenta. Verifica que el administrador haya autorizado tu correo; si ya te registraste, inicia sesión.',
  )
}

/**
 * Crea el acceso de una persona autorizada en `private.pending_staff`. Con la
 * confirmación de correo activa, Supabase no devuelve error si el correo ya
 * estaba confirmado: responde con un usuario sin identidades para no revelar
 * qué cuentas existen. Esa respuesta se distingue para no decir «revisa tu
 * correo» cuando ningún correo va a llegar.
 */
export async function signUpStaff(
  email: string,
  password: string,
): Promise<SignUpResult> {
  const { data, error } = await client().auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { emailRedirectTo: authRedirectUrl() },
  })
  if (error) throw signUpError(error)
  if (data.session) return 'confirmation_sent'
  return data.user && data.user.identities?.length === 0
    ? 'already_registered'
    : 'confirmation_sent'
}

/** Reenvía el correo de confirmación, con la misma dirección de regreso. */
export async function resendConfirmation(email: string) {
  const { error } = await client().auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: authRedirectUrl() },
  })
  if (error) throw signUpError(error)
}

/**
 * Canjea el enlace del correo por una sesión. El cliente se crea con
 * `detectSessionInUrl: false` para que ninguna pantalla consuma credenciales de
 * la dirección por accidente: sólo `/auth/callback` lo hace, y de forma
 * explícita para los tres formatos que Supabase puede enviar.
 */
export async function confirmAuthLink(link: AuthLink) {
  // Un aviso sin sesión (primer enlace de un cambio de correo) no se canjea.
  if (link.kind === 'notice') return
  if (link.kind === 'error')
    throw new AppError('unauthorized', authLinkErrorMessage(link.code))
  const auth = client().auth
  const { error } =
    link.kind === 'tokens'
      ? await auth.setSession({
          access_token: link.accessToken,
          refresh_token: link.refreshToken,
        })
      : link.kind === 'token_hash'
        ? await auth.verifyOtp({ token_hash: link.tokenHash, type: link.type })
        : await auth.exchangeCodeForSession(link.code)
  if (error)
    throw new AppError('unauthorized', authLinkErrorMessage(error.code ?? null))
}
