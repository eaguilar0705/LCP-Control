import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, LoaderCircle, MailWarning } from 'lucide-react'
import { Brand } from '../../components/Brand'
import { Card } from '../../components/ui'
import { errorMessage } from '../../lib/errors'
import { confirmAuthLink } from '../../services/auth'
import { useAuth } from './AuthContext'
import {
  AUTH_CALLBACK_PATH,
  authLinkErrorMessage,
  destinationAfterLink,
  parseAuthLink,
  type AuthLink,
} from './authLink'

type CallbackState =
  | { status: 'working' }
  | { status: 'done'; destination: string }
  | { status: 'error'; message: string }
  | { status: 'notice' }

function initialState(link: AuthLink | null): CallbackState {
  if (!link)
    return {
      status: 'error',
      message:
        'Este enlace no trae datos de confirmación. Ábrelo directamente desde el correo más reciente.',
    }
  if (link.kind === 'error')
    return { status: 'error', message: authLinkErrorMessage(link.code) }
  if (link.kind === 'notice') return { status: 'notice' }
  return { status: 'working' }
}

/**
 * Destino de los enlaces de correo de Supabase Auth. Canjea el enlace una sola
 * vez (StrictMode ejecuta los efectos dos veces en desarrollo y un enlace de un
 * solo uso fallaría la segunda), borra las credenciales de la barra de
 * direcciones y del historial, y abre el panel cuando la sesión ya existe.
 */
export function AuthCallbackPage({
  confirm = confirmAuthLink,
}: {
  confirm?: (link: AuthLink) => Promise<void>
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const started = useRef(false)
  // El enlace se lee una sola vez, antes de limpiar la barra de direcciones.
  const [link] = useState(() => parseAuthLink(location.search, location.hash))
  const [state, setState] = useState<CallbackState>(() => initialState(link))
  useEffect(() => {
    if (started.current) return
    started.current = true
    // Los tokens no deben quedar en el historial ni en capturas de pantalla.
    navigate(AUTH_CALLBACK_PATH, { replace: true })
    if (!link || link.kind === 'error' || link.kind === 'notice') return
    confirm(link)
      .then(() =>
        setState({ status: 'done', destination: destinationAfterLink(link) }),
      )
      .catch((error) =>
        setState({ status: 'error', message: errorMessage(error) }),
      )
  }, [confirm, link, navigate])
  // La sesión llega por onAuthStateChange; el rol se comprueba en ProtectedRoute.
  if (state.status === 'done' && user)
    return <Navigate to={state.destination} replace />
  return (
    <main className="main-content activation-page">
      <Card className="form-card auth-callback">
        <Brand wordmark />
        {state.status === 'working' && (
          <div className="auth-callback-state" role="status">
            <LoaderCircle className="spin" size={28} />
            <h1>Confirmando tu correo…</h1>
          </div>
        )}
        {state.status === 'done' && (
          <div className="auth-callback-state" role="status">
            <CheckCircle2 size={28} />
            <h1>Correo confirmado</h1>
            <p>Tu acceso está listo. Estamos abriendo el sistema.</p>
            <Link className="button button-primary" to={state.destination}>
              Entrar al sistema
            </Link>
          </div>
        )}
        {state.status === 'notice' && (
          <div className="auth-callback-state" role="status">
            <CheckCircle2 size={28} />
            <h1>Primer enlace confirmado</h1>
            <p>
              Para terminar el cambio de correo, abre también el enlace que
              enviamos a la otra dirección.
            </p>
            <Link className="button button-secondary" to="/login">
              Volver al inicio
            </Link>
          </div>
        )}
        {state.status === 'error' && (
          <div className="auth-callback-state" role="alert">
            <MailWarning size={28} />
            <h1>No se pudo confirmar</h1>
            <p>{state.message}</p>
            <div className="auth-callback-actions">
              <Link className="button button-primary" to="/login">
                Iniciar sesión
              </Link>
              <Link className="button button-secondary" to="/activate">
                Solicitar un correo nuevo
              </Link>
            </div>
          </div>
        )}
      </Card>
    </main>
  )
}
