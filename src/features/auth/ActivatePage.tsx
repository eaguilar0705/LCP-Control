import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Input, PasswordInput } from '../../components/ui'
import { Brand } from '../../components/Brand'
import { AppError, errorMessage } from '../../lib/errors'
import { authConfigured } from '../../lib/supabase'
import {
  resendConfirmation,
  signUpStaff,
  type SignUpResult,
} from '../../services/auth'

const RESEND_WAIT_SECONDS = 60

export function ActivatePage({
  signUp = signUpStaff,
  resend = resendConfirmation,
}: {
  signUp?: (email: string, password: string) => Promise<SignUpResult>
  resend?: (email: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<'signup' | 'resend' | null>(null)
  const [message, setMessage] = useState('')
  // Correo al que se envió la confirmación: habilita «Reenviar».
  const [sentTo, setSentTo] = useState('')
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const remaining = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const counting = remaining > 0
  // Supabase limita los reenvíos; la cuenta regresiva evita pulsar en vano.
  useEffect(() => {
    if (!counting) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [counting])

  function startCooldown() {
    const current = Date.now()
    setNow(current)
    setWaitUntil(current + RESEND_WAIT_SECONDS * 1000)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email') ?? '')
      .trim()
      .toLowerCase()
    const password = String(f.get('password') ?? '')
    if (password !== f.get('repeat')) {
      setMessage('Las contraseñas no coinciden.')
      return
    }
    setBusy('signup')
    setMessage('')
    try {
      // AppError: un Error común se mostraba como «No pudimos completar la
      // operación» y el motivo real se perdía.
      if (!authConfigured)
        throw new AppError(
          'configuration',
          'Configura Supabase para activar cuentas.',
        )
      const result = await signUp(email, password)
      if (result === 'already_registered') {
        setSentTo('')
        setMessage(
          'Este correo ya tiene acceso confirmado. Inicia sesión con tu contraseña.',
        )
        return
      }
      setSentTo(email)
      startCooldown()
      setMessage(
        `Te enviamos un enlace a ${email}. Ábrelo para confirmar tu correo: entrarás al sistema automáticamente.`,
      )
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  async function resendEmail() {
    if (busy || !sentTo || remaining > 0) return
    setBusy('resend')
    try {
      await resend(sentTo)
      startCooldown()
      setMessage(
        `Enviamos un correo nuevo a ${sentTo}. Usa el enlace más reciente.`,
      )
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="main-content activation-page">
      <Card className="form-card">
        <Brand wordmark />
        <h1>Activar mi cuenta</h1>
        <p>
          Solo pueden registrarse los correos autorizados por el administrador.
          Elige una contraseña personal.
        </p>
        <form onSubmit={submit}>
          <Input
            label="Correo autorizado"
            name="email"
            type="email"
            required
            autoComplete="username"
          />
          {/* Supabase no acepta contraseñas de más de 72 caracteres. */}
          <PasswordInput
            label="Contraseña"
            name="password"
            minLength={12}
            maxLength={72}
            required
            autoComplete="new-password"
          />
          <PasswordInput
            label="Repetir contraseña"
            name="repeat"
            minLength={12}
            maxLength={72}
            required
            autoComplete="new-password"
          />
          <p className="muted">Usa de 12 a 72 caracteres.</p>
          <Button
            type="submit"
            disabled={busy !== null}
            aria-busy={busy === 'signup'}
          >
            {busy === 'signup' ? 'Registrando…' : 'Crear mi acceso'}
          </Button>
        </form>
        {message && <p role="status">{message}</p>}
        {sentTo && (
          <div className="activation-resend">
            <span className="muted">
              ¿No llegó? Revisa la carpeta de spam o correo no deseado.
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null || remaining > 0}
              aria-busy={busy === 'resend'}
              onClick={() => void resendEmail()}
            >
              {busy === 'resend'
                ? 'Reenviando…'
                : remaining > 0
                  ? `Reenviar correo (${remaining} s)`
                  : 'Reenviar correo'}
            </Button>
          </div>
        )}
        <Link to="/login">Iniciar sesión</Link>
      </Card>
    </main>
  )
}
