import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { ErrorState, LoadingState, Button } from '../../components/ui'
export function ProtectedRoute() {
  const { user, loading, error, retry, service } = useAuth()
  const location = useLocation()
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} retry={retry} />
  if (!user)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (!user.role)
    return (
      <div className="access-state">
        <ErrorState message="Tu cuenta aún no tiene un rol autorizado. Solicita al administrador que habilite tu acceso." />
        <Button
          onClick={() => {
            void service.signOut().catch(retry)
          }}
        >
          Cerrar sesión
        </Button>
      </div>
    )
  return <Outlet />
}
