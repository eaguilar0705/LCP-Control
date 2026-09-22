import { Brand } from '../../components/Brand'
import { Reflection } from '../dashboard/Reflection'
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { useAuth } from './AuthContext'
import { Button, Input, LoadingState } from '../../components/ui'
import { loginSchema } from '../../lib/validation'
import { errorMessage } from '../../lib/errors'
import { authConfigured } from '../../lib/supabase'
export function LoginPage() {
  const { user, loading, service } = useAuth()
  const location = useLocation()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (loading) return <LoadingState />
  const from: unknown = location.state?.from
  if (user)
    return (
      <Navigate
        to={
          typeof from === 'string' &&
          /^\/(?!\/)/.test(from) &&
          from !== '/login'
            ? from
            : '/'
        }
        replace
      />
    )
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const result = loginSchema.safeParse({
      email: data.get('email'),
      password: data.get('password'),
    })
    if (!result.success) {
      setError(result.error.issues[0].message)
      return
    }
    setBusy(true)
    setError('')
    try {
      await service.signIn(result.data.email, result.data.password)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="login-brand-panel">
          <Brand wordmark />
        </div>
        <div>
          <h1>Bienvenido a tu tienda.</h1>
          <Reflection />
        </div>
        <span className="login-footer">La Casa del Perfume · Nicaragua</span>
      </section>
      <section className="login-form">
        <Brand wordmark className="login-mobile-brand" />
        <span className="eyebrow">LA CASA DEL PERFUME</span>
        <h2>Iniciar sesión</h2>
        <p className="muted">Ingresa con la cuenta de tu tienda.</p>
        <form onSubmit={submit}>
          <Input
            label="Correo electrónico"
            name="email"
            type="email"
            placeholder="tu@correo.com"
            autoComplete="username"
            required
          />
          <Input
            label="Contraseña"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Tu contraseña"
            required
          />
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Iniciando sesión…' : 'Iniciar sesión'}
            <ArrowRight size={18} />
          </Button>
        </form>
        {authConfigured && (
          <Link className="demo-link" to="/activate">
            Activar mi cuenta
          </Link>
        )}
        <p className="login-note">
          <ShieldCheck size={16} /> Acceso privado. Solicita tu cuenta al
          administrador.
        </p>
      </section>
    </main>
  )
}
