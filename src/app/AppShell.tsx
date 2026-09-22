import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  FileText,
  Layers3,
  Bell,
  LogOut,
  Truck,
  Menu,
  X,
  UserRound,
  ChartColumn,
} from 'lucide-react'
import { useAuth } from '../features/auth/AuthContext'
import { AccessContext } from './AccessContext'
import { Button } from '../components/ui'
import { Brand } from '../components/Brand'
import { errorMessage } from '../lib/errors'
import { can, roleLabels, type Capability } from '../lib/permissions'
const links = [
  ['', 'Inicio', LayoutDashboard],
  ['/inventory', 'Inventario', Package],
  ['/sales', 'Facturación', ShoppingBag],
  ['/proformas', 'Proformas', FileText],
  ['/reports', 'Reportes', ChartColumn],
  ['/alerts', 'Alertas', Bell],
  ['/suppliers', 'Proveedores', Truck],
  ['/account', 'Mi cuenta', UserRound],
  ['/customers', 'Clientes', UserRound],
  ['/inventory/history', 'Movimientos', Layers3],
  ['/staff', 'Usuarios', UserRound],
  ['/settings', 'Negocio', Layers3],
] as const
export function AppShell({ demo = false }: { demo?: boolean }) {
  const { user, service } = useAuth()
  const base = demo ? '/demo' : ''
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  async function logout() {
    setBusy(true)
    setError('')
    try {
      await service.signOut()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const role = demo ? 'operator' : (user?.role ?? null)
  return (
    <AccessContext.Provider
      value={{
        demo,
        base,
        role,
        storageScope: demo ? 'demo' : `user:${user?.id ?? 'anonymous'}`,
      }}
    >
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <div className="app-layout">
        <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`}>
          <Link className="brand" to={base || '/'}>
            <Brand />
            <span>
              La Casa del Perfume<small>ADMINISTRACIÓN</small>
            </span>
          </Link>
          <Button
            className="close-menu"
            variant="ghost"
            aria-label="Cerrar menú"
            onClick={() => setMenu(false)}
          >
            <X />
          </Button>
          <span className="nav-label">MI TIENDA</span>
          <nav aria-label="Navegación principal">
            {links
              .filter(([path]) => {
                const permission: Record<string, Capability> = {
                  '/sales': 'sale.create',
                  '/proformas': 'sale.create',
                  '/customers': 'customer.read',
                  '/suppliers': 'supplier.read',
                  '/reports': 'finance.read',
                  '/staff': 'staff.manage',
                  '/settings': 'settings.manage',
                }
                return demo || !permission[path] || can(role, permission[path])
              })
              .map(([path, label, Icon]) => (
                <NavLink
                  key={path}
                  end
                  to={base + path || '/'}
                  onClick={() => setMenu(false)}
                >
                  <Icon size={19} />
                  {label}
                </NavLink>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="user-block">
              <span className="avatar">
                {demo ? 'D' : user?.email.charAt(0).toUpperCase()}
              </span>
              <div>
                <strong>{demo ? 'Vista local' : user?.email}</strong>
                <small>
                  {demo
                    ? 'Sin conexión a base de datos'
                    : role
                      ? roleLabels[role]
                      : 'Sin acceso'}
                </small>
              </div>
            </div>
            {demo ? (
              <Link className="logout-link" to="/login">
                <LogOut size={16} /> Volver al acceso
              </Link>
            ) : (
              <Button variant="ghost" onClick={logout} disabled={busy}>
                <LogOut size={16} />
                {busy ? 'Cerrando…' : 'Cerrar sesión'}
              </Button>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="topbar-label">
              <Button
                className="mobile-menu"
                variant="ghost"
                aria-label="Abrir menú"
                onClick={() => setMenu(true)}
              >
                <Menu size={20} />
              </Button>
              <Brand className="header-brand" />
              <span>La Casa del Perfume</span>
              <span className="topbar-divider">/</span>
              <span className="muted">Administración</span>
            </div>
            <div className="topbar-actions">
              <Link aria-label="Ver alertas" to={`${base}/alerts`}>
                <Bell size={20} />
              </Link>
              <span className="avatar avatar-small">
                {demo ? 'D' : user?.email.charAt(0).toUpperCase()}
              </span>
            </div>
          </header>
          {/* Un aside es una región con nombre: sin landmark este aviso queda
              fuera del recorrido por regiones de un lector de pantalla. */}
          {demo && (
            <aside className="demo-banner" aria-label="Aviso de vista local">
              <span>
                Vista local · Los borradores se guardan únicamente en este
                navegador.
              </span>
            </aside>
          )}
          {!online && (
            <div role="alert" className="offline-banner">
              Sin conexión. Las fotos externas pueden no estar disponibles.
            </div>
          )}
          <main id="main" className="main-content">
            <Outlet key={`${demo ? 'demo' : user?.id}:${role}`} />
          </main>
          <footer className="workspace-footer">
            La Casa del Perfume<span>Managua, Nicaragua</span>
          </footer>
        </div>
        <nav className="bottom-nav" aria-label="Navegación móvil">
          {links.slice(0, 4).map(([path, label, Icon]) => (
            <NavLink key={path} end to={base + path || '/'}>
              <Icon size={22} />
              <span>{label}</span>
            </NavLink>
          ))}
          <button onClick={() => setMenu(true)}>
            <Menu size={22} />
            <span>Más</span>
          </button>
        </nav>
      </div>
    </AccessContext.Provider>
  )
}
