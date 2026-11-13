import { useEffect } from 'react'
import { useRouteError } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { Button } from '../components/ui'
import { isChunkLoadError, recoverChunkLoad } from './chunkRecovery'

export function ApplicationError({ error }: { error: unknown }) {
  useEffect(() => {
    recoverChunkLoad(error)
  }, [error])

  return (
    <main className="main-content">
      <div className="state error" role="alert">
        <AlertCircle size={28} />
        <h1>No pudimos cargar esta pantalla</h1>
        <p>
          {isChunkLoadError(error)
            ? 'No pudimos descargar una parte de la aplicación. Comprueba tu conexión y recarga para continuar.'
            : 'Ocurrió un error al mostrar la pantalla. Recarga la aplicación para continuar.'}
        </p>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Recargar aplicación
        </Button>
        <a className="button button-secondary" href="/">
          Ir al inicio
        </a>
      </div>
    </main>
  )
}

export function RouteError() {
  return <ApplicationError error={useRouteError()} />
}
