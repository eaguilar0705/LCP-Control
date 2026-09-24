import { roleLabels } from '../../lib/permissions'
import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext'
import { useAccess } from '../../app/AccessContext'
import { supabase } from '../../lib/supabase'
import { authRedirectUrl } from '../../services/auth'
import { useQuery } from '../../lib/useQuery'
import { AppError } from '../../lib/errors'
import {
  Button,
  Card,
  Input,
  LoadingState,
  ErrorState,
  PasswordInput,
} from '../../components/ui'
const MIN_PASSWORD = 12
// Límite de Supabase Auth para contraseñas.
const MAX_PASSWORD = 72
// AppError: los mensajes llegan a la pantalla tal cual. Con un Error común
// useQuery los cambiaba por «No pudimos completar la operación».
async function getProfile() {
  if (!supabase)
    throw new AppError('configuration', 'Falta configurar Supabase.')
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth.user)
    throw new AppError('unauthorized', 'Vuelve a iniciar sesión.')
  const { data, error } = await supabase
    .from('staff_members')
    .select('display_name')
    .eq('user_id', auth.user.id)
    .single()
  if (error) throw new AppError('network', 'No pudimos leer tu perfil.')
  return data.display_name as string
}
export function AccountPage() {
  const { demo } = useAccess()
  return demo ? (
    <AccountForm initialName="Usuario de ejemplo" />
  ) : (
    <AccountLoader />
  )
}
function AccountLoader() {
  const { data, loading, error, retry } = useQuery(getProfile)
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} retry={retry} />
  return <AccountForm initialName={data ?? ''} />
}
type Section = 'name' | 'email' | 'password'
function AccountForm({ initialName }: { initialName: string }) {
  const { user } = useAuth()
  const { demo } = useAccess()
  const [name, setName] = useState(initialName)
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  // El aviso se muestra en la tarjeta que lo produjo. Antes aparecía al final
  // de la página, debajo de las tres tarjetas: en el teléfono quedaba fuera de
  // la pantalla y parecía que el botón no había hecho nada.
  const [feedback, setFeedback] = useState<{
    section: Section
    tone: 'status' | 'alert'
    text: string
  } | null>(null)
  const report = (section: Section, tone: 'status' | 'alert', text: string) =>
    setFeedback({ section, tone, text })
  async function save(event: FormEvent, section: Section) {
    event.preventDefault()
    if (busy || demo || !supabase) return
    setFeedback(null)
    if (section === 'name' && !name.trim()) {
      report('name', 'alert', 'Escribe tu nombre.')
      return
    }
    if (
      section === 'password' &&
      (password.length < MIN_PASSWORD ||
        password.length > MAX_PASSWORD ||
        password !== repeat)
    ) {
      report(
        'password',
        'alert',
        `Usa de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres y repite la misma contraseña.`,
      )
      return
    }
    setBusy(true)
    try {
      const result =
        section === 'name'
          ? await supabase.rpc('update_my_profile', { p_name: name.trim() })
          : section === 'email'
            ? // Sin emailRedirectTo el enlace de confirmación volvería a la
              // «Site URL» del proyecto (el equipo de desarrollo).
              await supabase.auth.updateUser(
                { email: email.trim() },
                { emailRedirectTo: authRedirectUrl() },
              )
            : await supabase.auth.updateUser({ password })
      if (result.error) {
        report(
          section,
          'alert',
          'No se pudo completar el cambio. Revisa los datos; si tu sesión venció, vuelve a entrar.',
        )
        return
      }
      report(
        section,
        'status',
        section === 'email'
          ? 'Solicitud enviada. Revisa los correos de confirmación para completar el cambio de dirección.'
          : section === 'password'
            ? 'Contraseña actualizada.'
            : 'Nombre actualizado.',
      )
      setPassword('')
      setRepeat('')
    } catch {
      report(section, 'alert', 'No pudimos conectar. Inténtalo de nuevo.')
    } finally {
      setBusy(false)
    }
  }
  function notice(section: Section) {
    if (feedback?.section !== section) return null
    return feedback.tone === 'alert' ? (
      <p role="alert" className="inline-error">
        {feedback.text}
      </p>
    ) : (
      <p role="status" className="page-feedback">
        {feedback.text}
      </p>
    )
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Mi cuenta</h1>
          <p className="muted">
            Actualiza tu nombre y los datos con los que entras al sistema.
          </p>
        </div>
      </div>
      {demo && (
        <p className="page-feedback">
          Vista de ejemplo. Los cambios requieren iniciar sesión.
        </p>
      )}
      <div className="account-grid">
        <Card className="form-card">
          <form onSubmit={(e) => void save(e, 'name')}>
            <h2>Perfil</h2>
            <Input
              label="Nombre visible"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="muted">
              Rol:{' '}
              {demo
                ? 'Ejemplo'
                : user?.role
                  ? roleLabels[user.role]
                  : 'Sin permisos'}
            </p>
            {notice('name')}
            <Button type="submit" disabled={busy || demo} aria-busy={busy}>
              Guardar nombre
            </Button>
          </form>
        </Card>
        <Card className="form-card">
          <form onSubmit={(e) => void save(e, 'email')}>
            <h2>Correo de acceso</h2>
            <Input
              label="Nuevo correo"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="muted">
              El cambio puede requerir confirmación por correo.
            </p>
            {notice('email')}
            <Button
              type="submit"
              disabled={
                busy ||
                demo ||
                email.trim().toLowerCase() === user?.email?.toLowerCase()
              }
              aria-busy={busy}
            >
              Cambiar correo
            </Button>
          </form>
        </Card>
        <Card className="form-card">
          <form onSubmit={(e) => void save(e, 'password')}>
            <h2>Contraseña</h2>
            <PasswordInput
              label="Nueva contraseña"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordInput
              label="Repetir contraseña"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            {notice('password')}
            <Button type="submit" disabled={busy || demo} aria-busy={busy}>
              Cambiar contraseña
            </Button>
          </form>
        </Card>
      </div>
    </>
  )
}
