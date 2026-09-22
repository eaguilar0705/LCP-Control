import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './features/auth/AuthProvider'
import { App } from './app/App'
import { ErrorBoundary } from './app/ErrorBoundary'
import './app/styles.css'
import './app/identity.css'
import './app/catalog-documents.css'
import './app/workspace-polish.css'
import './app/brand-accents.css'
import './app/selects.css'
import './app/login.css'
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
