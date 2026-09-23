import { roleLabels } from '../../lib/permissions'
import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext'
import { useAccess } from '../../app/AccessContext'
import { supabase } from '../../lib/supabase'
import { authRedirectUrl } from '../../services/auth'
import { useQuery } from '../../lib/useQuery'
import {
  Button,
  Card,
  Input,
  LoadingState,
  ErrorState,
  PasswordInput,
} from '../../components/ui'
const MIN_PASSWORD = 12
async function getProfile() {
  if (!supabase) throw new Error('Falta configurar Supabase.')
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth.user) throw new Error('Vuelve a iniciar sesión.')
  const { data, error } = await supabase
    .from('staff_members')
    .select('display_name')
    .eq('user_id', auth.user.id)
    .single()
  if (error) throw new Error('No pudimos leer tu perfil.')
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
function AccountForm({ initialName }: { initialName: string }) {
  const { user } = useAuth()
  const { demo } = useAccess()
  const [name, setName] = useState(initialName)
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function save(
    event: FormEvent,
    section: 'name' | 'email' | 'password',
  ) {
    event.preventDefault()
    if (busy || demo || !supabase) return
    setMessage('')
    setError('')
    if (
      section === 'password' &&
      (password.length < MIN_PASSWORD || password !== repeat)
    ) {
      setError(
        `Usa al menos ${MIN_PASSWORD} caracteres y repite la misma contraseña.`,
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
        setError(
          'No se pudo completar el cambio. Revisa los datos; si tu sesión venció, vuelve a entrar.',
        )
        return
      }
      setMessage(
        section === 'email'
          ? 'Solicitud enviada. Revisa los correos de confirmación para completar el cambio de dirección.'
          : section === 'password'
            ? 'Contraseña actualizada.'
            : 'Nombre actualizado.',
      )
      setPassword('')
      setRepeat('')
    } catch {
      setError('No pudimos conectar. Inténtalo de nuevo.')
    } finally {
      setBusy(false)
    }
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="muted">
              El cambio puede requerir confirmación por correo.
            </p>
            <Button
              type="submit"
              disabled={busy || demo || email === user?.email}
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordInput
              label="Repetir contraseña"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            <Button type="submit" disabled={busy || demo} aria-busy={busy}>
              Cambiar contraseña
            </Button>
          </form>
        </Card>
      </div>
      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </>
  )
}
