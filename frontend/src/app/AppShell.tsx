import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  Calculator,
  Globe,
} from 'lucide-react'
import { useAuth } from '../features/auth/AuthContext'
import { AccessContext } from './AccessContext'
import { Button } from '../components/ui'
import { Brand } from '../components/Brand'
import { StorefrontBadge } from '../features/storefront/StorefrontBadge'
import { PriceTiersBoundary } from '../components/PriceTiersBoundary'
import { OperationRecoveryBanner } from '../components/OperationRecoveryBanner'
import {
  getOperationReferences,
  operationReferencesRevision,
  subscribeOperationReferences,
} from '../lib/operationRecovery'
import { errorMessage } from '../lib/errors'
import { can, roleLabels, type Capability } from '../lib/permissions'
import {
  pendingDocuments,
  pendingDocumentsRevision,
  subscribePendingDocuments,
} from '../features/sales/pendingDocuments'
import {
  getPendingJournal,
  pendingJournalRevision,
  subscribePendingJournal,
} from '../features/accounting/pendingJournal'
import {
  listPendingOperations,
  subscribePendingOperations,
  pendingOperationsRevision,
} from '../lib/idempotentOperation'
const links = [
  ['', 'Inicio', LayoutDashboard],
  ['/inventory', 'Inventario', Package],
  ['/sales', 'Facturación', ShoppingBag],
  ['/proformas', 'Proformas', FileText],
  ['/storefront', 'Tienda online', Globe],
  ['/reports', 'Reportes', ChartColumn],
  ['/accounting', 'Contabilidad', Calculator],
  ['/alerts', 'Alertas', Bell],
  ['/suppliers', 'Proveedores', Truck],
  ['/account', 'Mi cuenta', UserRound],
  ['/customers', 'Clientes', UserRound],
  ['/inventory/history', 'Movimientos', Layers3],
  ['/staff', 'Usuarios', UserRound],
  ['/settings', 'Negocio', Layers3],
] as const
// Pantallas que exigen un permiso. El menú lateral y la barra inferior del
// teléfono usan la misma regla: un enlace que sólo lleva a «No tienes permiso»
// no se muestra en ninguno de los dos.
const linkPermission: Record<string, Capability> = {
  '/inventory': 'inventory.read',
  '/inventory/history': 'inventory.read',
  '/alerts': 'inventory.read',
  '/sales': 'sale.create',
  '/proformas': 'proforma.create',
  '/customers': 'customer.read',
  '/suppliers': 'supplier.read',
  '/reports': 'finance.read',
  '/accounting': 'pricing.manage',
  '/staff': 'staff.manage',
  '/settings': 'settings.manage',
  '/storefront': 'settings.manage',
}
// Mismo corte que la hoja de estilos: por encima, el menú lateral es fijo.
const DESKTOP_QUERY = '(min-width: 761px)'
export function AppShell({ demo = false }: { demo?: boolean }) {
  const { user, service } = useAuth()
  const base = demo ? '/demo' : ''
  const storageScope = demo ? 'demo' : `user:${user?.id ?? 'anonymous'}`
  useSyncExternalStore(subscribePendingDocuments, pendingDocumentsRevision)
  useSyncExternalStore(subscribePendingJournal, pendingJournalRevision)
  const operationsRevision = useSyncExternalStore(
    subscribePendingOperations,
    pendingOperationsRevision,
  )
  const outstanding = demo ? [] : pendingDocuments(storageScope)
  const outstandingJournal = !demo && getPendingJournal(storageScope)
  const outstandingOperations = demo ? [] : listPendingOperations(storageScope)
  useSyncExternalStore(
    subscribeOperationReferences,
    operationReferencesRevision,
  )
  const recoveredReferences = demo
    ? []
    : getOperationReferences(storageScope).filter(
        (reference) =>
          !outstandingOperations.some(
            (entry) => entry.key === reference.kind,
          ) &&
          !outstanding.some((entry) => entry.kind === reference.kind) &&
          !(outstandingJournal && reference.kind === 'journal'),
      )
  const [verifying, setVerifying] = useState<string | null>(null)
  const [operationNotice, setOperationNotice] = useState<{
    revision: number
    message?: string
    error?: string
  } | null>(null)
  const currentOperationNotice =
    operationNotice?.revision === operationsRevision ? operationNotice : null
  async function verifyOperation(
    entry: (typeof outstandingOperations)[number],
  ) {
    if (verifying) return
    setVerifying(entry.key)
    setError('')
    setOperationNotice(null)
    try {
      await entry.operation.retryPending()
      setOperationNotice({
        revision: pendingOperationsRevision(),
        message: 'Operación confirmada. Consulta el historial.',
      })
    } catch (failure) {
      setOperationNotice({
        revision: pendingOperationsRevision(),
        error: errorMessage(failure),
      })
    } finally {
      setVerifying(null)
    }
  }
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  // Quien abrió el menú recupera el foco al cerrarlo.
  const opener = useRef<HTMLElement | null>(null)
  function openMenu() {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setMenu(true)
  }
  // En el teléfono el menú es un panel sobre la pantalla: el foco entra en él,
  // Escape lo cierra y, si la ventana pasa a tamaño de escritorio, se cierra
  // solo para no dejar el contenido bloqueado detrás de un panel invisible.
  useEffect(() => {
    if (!menu) {
      // Ya sin `inert` en la página: el botón que abrió el menú vuelve a
      // recibir el foco (un elemento inerte no puede recibirlo).
      opener.current?.focus()
      opener.current = null
      return
    }
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenu(false)
    }
    const desktop = window.matchMedia?.(DESKTOP_QUERY)
    const onResize = () => {
      if (desktop?.matches) setMenu(false)
    }
    document.addEventListener('keydown', onKey)
    desktop?.addEventListener?.('change', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      desktop?.removeEventListener?.('change', onResize)
    }
  }, [menu])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    if (
      !outstanding.length &&
      !outstandingJournal &&
      !outstandingOperations.length
    )
      return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [outstanding.length, outstandingJournal, outstandingOperations.length])
  async function logout() {
    if (!demo && recoveredReferences.length) {
      setError(
        'Confirma primero las solicitudes pendientes antes de cerrar sesión.',
      )
      return
    }
    if (!demo && listPendingOperations(storageScope).length) {
      setError(
        'Confirma primero las operaciones pendientes antes de cerrar sesión.',
      )
      return
    }
    if (!demo && getPendingJournal(storageScope)) {
      setError(
        'Confirma primero el comprobante pendiente antes de cerrar sesión.',
      )
      return
    }
    if (!demo && pendingDocuments(storageScope).length) {
      setError(
        'Confirma primero las emisiones pendientes antes de cerrar sesión.',
      )
      return
    }
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
  const visibleLinks = links.filter(
    ([path]) =>
      demo || !linkPermission[path] || can(role, linkPermission[path]),
  )
  return (
    <AccessContext.Provider
      value={{
        demo,
        base,
        role,
        storageScope,
      }}
    >
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <div className="app-layout">
        {/* Velo del menú del teléfono. Antes era una sombra sobre la página: el
            toque pasaba a lo que había debajo y podía pulsar un botón oculto
            (abrir un movimiento, emitir una factura). Ahora el toque cierra. */}
        {menu && (
          <div
            className="sidebar-backdrop"
            aria-hidden="true"
            onClick={() => setMenu(false)}
          />
        )}
        <aside
          id="app-sidebar"
          className={`sidebar ${menu ? 'sidebar-open' : ''}`}
        >
          <Link className="brand" to={base || '/'}>
            <Brand />
            <span>
              La Casa del Perfume<small>ADMINISTRACIÓN</small>
            </span>
          </Link>
          <Button
            ref={closeButton}
            type="button"
            className="close-menu"
            variant="ghost"
            aria-label="Cerrar menú"
            onClick={() => setMenu(false)}
          >
            <X />
          </Button>
          <span className="nav-label">MI TIENDA</span>
          <nav aria-label="Navegación principal">
            {visibleLinks.map(([path, label, Icon]) => (
              <NavLink
                key={path}
                end
                to={base + path || '/'}
                onClick={() => {
                  opener.current = null
                  setMenu(false)
                }}
              >
                <Icon size={19} />
                {label}
                {path === '/storefront' && (
                  <StorefrontBadge
                    enabled={!demo && can(role, 'settings.manage')}
                  />
                )}
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
              <Button
                variant="ghost"
                onClick={logout}
                disabled={busy || outstanding.length > 0}
              >
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
        {/* Con el menú abierto, el contenido y la barra inferior quedan fuera
            del recorrido del teclado y del lector de pantalla. */}
        <div className="workspace" inert={menu || undefined}>
          <header className="topbar">
            <div className="topbar-label">
              <Button
                type="button"
                className="mobile-menu"
                variant="ghost"
                aria-label="Abrir menú"
                aria-expanded={menu}
                aria-controls="app-sidebar"
                onClick={openMenu}
              >
                <Menu size={20} />
              </Button>
              <Brand className="header-brand" />
              <span>La Casa del Perfume</span>
              <span className="topbar-divider">/</span>
              <span className="muted">Administración</span>
            </div>
            <div className="topbar-actions">
              {(demo || can(role, 'inventory.read')) && (
                <Link aria-label="Ver alertas" to={`${base}/alerts`}>
                  <Bell size={20} />
                </Link>
              )}
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
              Sin conexión. Para guardar ventas y abrir o cerrar tienda
              necesitas internet. Al volver, reintenta la operación original
              para evitar duplicados.
            </div>
          )}
          <OperationRecoveryBanner
            references={recoveredReferences}
            base={base}
            onConfirmed={() => setError('')}
          />
          {outstanding.length > 0 && (
            <aside
              className="sales-pending-banner no-print"
              aria-label="Emisiones por confirmar"
              role="status"
            >
              <strong>Hay una emisión pendiente de confirmar.</strong>
              {outstanding.map((attempt) => (
                <Link
                  key={attempt.kind}
                  to={`${base}/${attempt.kind === 'invoice' ? 'sales' : 'proformas'}`}
                >
                  Recuperar{' '}
                  {attempt.kind === 'invoice' ? 'factura' : 'proforma'}
                </Link>
              ))}
            </aside>
          )}
          {outstandingJournal && (
            <aside
              className="sales-pending-banner no-print"
              aria-label="Comprobante por confirmar"
              role="status"
            >
              <strong>Hay un comprobante pendiente de confirmar.</strong>
              <Link to={`${base}/accounting`}>Verificar comprobante</Link>
            </aside>
          )}
          {outstandingOperations.length > 0 && (
            <aside
              className="sales-pending-banner no-print"
              aria-label="Operaciones por confirmar"
              role="status"
            >
              {outstandingOperations.map((entry) => (
                <div key={entry.key} className="pending-operation-row">
                  <strong>{entry.label} pendiente de confirmar.</strong>
                  <Button
                    variant="secondary"
                    disabled={verifying !== null}
                    onClick={() => void verifyOperation(entry)}
                  >
                    {verifying === entry.key
                      ? 'Verificando…'
                      : 'Verificar operación'}
                  </Button>
                </div>
              ))}
            </aside>
          )}
          {currentOperationNotice?.message && !outstandingOperations.length && (
            <p role="status" className="workspace-feedback">
              {currentOperationNotice.message}
            </p>
          )}
          {currentOperationNotice?.error && (
            <p role="alert" className="inline-error">
              {currentOperationNotice.error}
            </p>
          )}
          <main id="main" className="main-content">
            <PriceTiersBoundary demo={demo}>
              <Outlet key={`${demo ? 'demo' : user?.id}:${role}`} />
            </PriceTiersBoundary>
          </main>
          <footer className="workspace-footer">
            La Casa del Perfume<span>Managua, Nicaragua</span>
          </footer>
        </div>
        <nav
          className="bottom-nav"
          aria-label="Navegación móvil"
          inert={menu || undefined}
        >
          {visibleLinks.slice(0, 4).map(([path, label, Icon]) => (
            <NavLink key={path} end to={base + path || '/'}>
              <Icon size={22} />
              <span>{label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            aria-expanded={menu}
            aria-controls="app-sidebar"
            onClick={openMenu}
          >
            <Menu size={22} />
            <span>Más</span>
          </button>
        </nav>
      </div>
    </AccessContext.Provider>
  )
}
