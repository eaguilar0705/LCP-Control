import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './features/auth/AuthProvider'
import { App } from './app/App'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles/styles.css'
import './styles/identity.css'
import './styles/catalog-documents.css'
import './styles/workspace-polish.css'
import './styles/brand-accents.css'
import './styles/selects.css'
import './styles/login.css'
import './styles/inventory-locations.css'
import './styles/document-print.css'
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)
