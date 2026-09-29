import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Brand } from '../../components/Brand'
import {
  Button,
  Card,
  Input,
  LoadingState,
  PasswordInput,
} from '../../components/ui'
import { errorMessage } from '../../lib/errors'
import { requestPasswordReset, replacePassword } from '../../services/auth'
import { useAuth } from './AuthContext'

export function RecoveryPage({ reset = false }: { reset?: boolean }) {
  const { user, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    if (!cooldown) return
    const timeout = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timeout)
  }, [cooldown])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || cooldown) return
    setError('')
    if (
      reset &&
      (password.length < 12 || password.length > 72 || password !== repeat)
    ) {
      setError('Usa de 12 a 72 caracteres y repite la misma contraseña.')
      return
    }
    setBusy(true)
    try {
      if (reset) {
        await replacePassword(password)
        setPassword('')
        setRepeat('')
        setDone(true)
      } else {
        await requestPasswordReset(email)
        setSent(true)
        setCooldown(60)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  if (reset && loading) return <LoadingState />
  return (
    <main className="main-content activation-page">
      <Card className="form-card recovery-card">
        <Brand wordmark />
        <h1>{reset ? 'Nueva contraseña' : 'Recuperar contraseña'}</h1>
        {done ? (
          <>
            <p role="status">
              Tu contraseña se actualizó. Ya puedes continuar usando el sistema.
            </p>
            <Link className="button button-primary" to="/">
              Ir al inicio
            </Link>
          </>
        ) : reset && !user ? (
          <>
            <p>
              Abre el enlace del correo más reciente para elegir una contraseña
              nueva.
            </p>
            <Link className="button button-primary" to="/forgot-password">
              Solicitar otro enlace
            </Link>
          </>
        ) : (
          <>
            <p className="muted">
              {reset
                ? 'Elige una contraseña de 12 a 72 caracteres que no uses en otros servicios.'
                : 'Escribe el correo de tu cuenta. Te enviaremos un enlace para elegir una contraseña nueva.'}
            </p>
            <form onSubmit={submit}>
              {reset ? (
                <>
                  <PasswordInput
                    label="Nueva contraseña"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={12}
                    maxLength={72}
                    required
                  />
                  <PasswordInput
                    label="Repetir contraseña"
                    autoComplete="new-password"
                    value={repeat}
                    onChange={(event) => setRepeat(event.target.value)}
                    minLength={12}
                    maxLength={72}
                    required
                  />
                </>
              ) : (
                <Input
                  label="Correo electrónico"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              )}
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              {sent && (
                <p role="status">
                  Si el correo corresponde a una cuenta, recibirás un enlace.
                  Revisa también la carpeta de spam y utiliza el correo más
                  reciente.
                </p>
              )}
              <Button
                type="submit"
                disabled={busy || cooldown > 0}
                aria-busy={busy}
              >
                {busy
                  ? 'Procesando…'
                  : cooldown
                    ? `Reenviar en ${cooldown} s`
                    : reset
                      ? 'Guardar contraseña'
                      : sent
                        ? 'Reenviar enlace'
                        : 'Enviar enlace'}
              </Button>
            </form>
          </>
        )}
        <Link className="demo-link" to="/login">
          Volver a iniciar sesión
        </Link>
      </Card>
    </main>
  )
}
