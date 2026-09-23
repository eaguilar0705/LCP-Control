import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './AppShell'
import { LoginPage } from '../features/auth/LoginPage'
import { ProtectedRoute } from '../features/auth/ProtectedRoute'
import { EmptyState, LoadingState } from '../components/ui'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { InventoryPage } from '../features/inventory/InventoryPage'
import { AlertsPage } from '../features/alerts/AlertsPage'
import { ProductEditorPage } from '../features/products/ProductEditorPage'
import { AccountPage } from '../features/auth/AccountPage'
import { DocumentExamplePage } from '../features/sales/DocumentExamplePage'
import { SuppliersPage } from '../features/suppliers/SuppliersPage'
import { ContactsPage } from '../features/contacts/ContactsPage'
import { ActivatePage } from '../features/auth/ActivatePage'
import { AuthCallbackPage } from '../features/auth/AuthCallbackPage'
import { AUTH_CALLBACK_PATH, hasAuthLink } from '../features/auth/authLink'
import { MovementHistory } from '../features/inventory/MovementHistory'
import { DocumentHistory } from '../features/sales/DocumentHistory'
import { useAccess } from './AccessContext'
import { can, type Capability } from '../lib/permissions'
function AccessGate({
  permission,
  children,
}: {
  permission: Capability
  children: React.ReactNode
}) {
  const { demo, role } = useAccess()
  return demo || can(role, permission) ? (
    children
  ) : (
    <EmptyState
      title="No tienes permiso para esta pantalla."
      description="Pídele acceso a un administrador si necesitas trabajar aquí."
    />
  )
}
// Fuera del panel no hay menú lateral ni barra inferior: sin un enlace de
// vuelta, la única salida de una dirección equivocada es el botón del navegador.
function NotFound() {
  return (
    <div className="state">
      <h3>Página no encontrada</h3>
      <p>La dirección no existe o la pantalla cambió de lugar.</p>
      <Link className="button button-secondary" to="/">
        Ir al inicio
      </Link>
    </div>
  )
}
const ReportsPage = lazy(() =>
  import('../features/reports/ReportsPage').then((page) => ({
    default: page.ReportsPage,
  })),
)
const StaffPage = lazy(() =>
  import('../features/administration/AdministrationPage').then((page) => ({
    default: page.StaffPage,
  })),
)
const BusinessPage = lazy(() =>
  import('../features/administration/AdministrationPage').then((page) => ({
    default: page.BusinessPage,
  })),
)
const ScannerPage = lazy(() =>
  import('../features/scanner/ScannerPage').then((page) => ({
    default: page.ScannerPage,
  })),
)
function InventoryRedirect() {
  const { base } = useAccess()
  return <Navigate to={`${base}/inventory`} replace />
}
const SalesPage = lazy(() =>
  import('../features/sales/SalesPage').then((page) => ({
    default: page.SalesPage,
  })),
)
const ProformaPage = lazy(() =>
  import('../features/sales/ProformaPage').then((page) => ({
    default: page.ProformaPage,
  })),
)
// La «Site URL» de Supabase puede devolver al inicio o a /login con los datos del
// enlace en la dirección. ProtectedRoute redirigiría a /login y el fragmento
// (#access_token=…) se perdería; por eso se desvía antes a /auth/callback.
function AuthLinkGate({ children }: { children: React.ReactNode }) {
  const { pathname, search, hash } = useLocation()
  if (pathname === AUTH_CALLBACK_PATH || !hasAuthLink(pathname, search, hash))
    return children
  return (
    <Navigate to={{ pathname: AUTH_CALLBACK_PATH, search, hash }} replace />
  )
}
export function App() {
  const pages = (
    <>
      <Route index element={<DashboardPage />} />
      <Route path="inventory" element={<InventoryPage />} />
      <Route path="scanner" element={<ScannerPage />} />
      <Route path="suppliers" element={<SuppliersPage />} />
      <Route
        path="sales"
        element={
          <AccessGate permission="sale.create">
            <SalesPage />
          </AccessGate>
        }
      />
      <Route
        path="proformas"
        element={
          <AccessGate permission="sale.create">
            <ProformaPage />
          </AccessGate>
        }
      />
      <Route path="customers" element={<ContactsPage kind="customers" />} />
      <Route path="staff" element={<StaffPage />} />
      <Route path="settings" element={<BusinessPage />} />
      <Route path="inventory/history" element={<MovementHistory />} />
      <Route
        path="sales/history"
        element={
          <AccessGate permission="sale.create">
            <DocumentHistory key="invoice" kind="invoice" />
          </AccessGate>
        }
      />
      <Route
        path="proformas/history"
        element={
          <AccessGate permission="sale.create">
            <DocumentHistory key="proforma" kind="proforma" />
          </AccessGate>
        }
      />
      <Route path="products" element={<InventoryRedirect />} />
      <Route path="products/new" element={<ProductEditorPage />} />
      <Route path="products/manage" element={<InventoryRedirect />} />
      <Route path="products/:id/edit" element={<ProductEditorPage />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="documents/example/:kind" element={<DocumentExamplePage />} />
      <Route
        path="reports"
        element={
          <AccessGate permission="finance.read">
            <ReportsPage />
          </AccessGate>
        }
      />
      <Route path="alerts" element={<AlertsPage />} />
    </>
  )
  return (
    <Suspense fallback={<LoadingState />}>
      <AuthLinkGate>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/activate" element={<ActivatePage />} />
          <Route path={AUTH_CALLBACK_PATH} element={<AuthCallbackPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<AppShell />}>
              {pages}
            </Route>
          </Route>
          {/* Vista local con datos sintéticos: sólo existe en desarrollo y pruebas. */}
          {import.meta.env.DEV && (
            <Route path="/demo" element={<AppShell demo />}>
              {pages}
            </Route>
          )}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthLinkGate>
    </Suspense>
  )
}
