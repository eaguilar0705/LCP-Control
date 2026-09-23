import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, ScanLine } from 'lucide-react'
import { Button, Dialog, Input } from '../../components/ui'
import { createHtml5Adapter } from './html5Adapter'
import { ScannerSession, type ScanState } from './ScannerSession'

/** Keeps the document/editor mounted and releases the camera when the dialog closes. */
export function ScanButton({
  onCode,
  manufacturer = false,
}: {
  onCode: (code: string) => void
  manufacturer?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="scan-search-button"
        onClick={() => setOpen(true)}
      >
        <ScanLine size={18} /> {manufacturer ? 'Leer código' : 'Escanear'}
      </Button>
      {open &&
        createPortal(
          <ScanCapture
            manufacturer={manufacturer}
            onClose={() => setOpen(false)}
            onCode={onCode}
          />,
          document.body,
        )}
    </>
  )
}

function ScanCapture({
  onCode,
  onClose,
  manufacturer,
}: {
  onCode: (code: string) => void
  onClose: () => void
  manufacturer: boolean
}) {
  const elementId = `scan-dialog-${useId().replaceAll(':', '')}`
  const controller = useRef<ScannerSession | null>(null)
  const callbacks = useRef({ onCode, onClose })
  const [code, setCode] = useState('')
  const [state, setState] = useState<ScanState>({ status: 'idle' })
  useEffect(() => {
    callbacks.current = { onCode, onClose }
  }, [onCode, onClose])
  useEffect(() => {
    let active = true
    const session = new ScannerSession(
      createHtml5Adapter(elementId),
      async () => null,
      (next) => {
        if (!active) return
        if (next.status === 'unknown') {
          if (manufacturer && !/^(?:\d{8}|\d{12,14})$/.test(next.code)) {
            setState({
              status: 'error',
              message:
                'Lee el código EAN o UPC del envase: 8, 12, 13 o 14 dígitos.',
            })
            return
          }
          callbacks.current.onCode(next.code)
          callbacks.current.onClose()
        } else setState(next)
      },
    )
    controller.current = session
    return () => {
      active = false
      void session.cancel()
      controller.current = null
    }
  }, [elementId, manufacturer])
  const cameraActive =
    state.status === 'starting' || state.status === 'scanning'
  const busy = cameraActive || state.status === 'looking'
  return (
    <Dialog
      open
      title={manufacturer ? 'Código del fabricante' : 'Buscar con un código'}
      onClose={onClose}
    >
      <p className="muted">
        {manufacturer
          ? 'Escanea la etiqueta del envase para completar el código del perfume.'
          : 'Escanea la etiqueta y verás el perfume en la búsqueda de esta pantalla.'}
      </p>
      <div className={`camera-stage ${cameraActive ? 'camera-active' : ''}`}>
        <div id={elementId} className="camera-reader" />
        {!cameraActive && (
          <div className="camera-placeholder">
            <Camera size={36} />
            <p>Acerca la etiqueta a la cámara</p>
          </div>
        )}
      </div>
      <div className="scanner-controls">
        {cameraActive ? (
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              // Aunque la cámara no responda al detenerse, la pantalla vuelve
              // a su estado inicial en lugar de quedar con el botón inservible.
              try {
                await controller.current?.cancel()
              } catch {
                // El lector ya se había detenido o perdió el permiso.
              } finally {
                setState({ status: 'idle' })
              }
            }}
          >
            Detener cámara
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void controller.current?.start()}
          >
            <Camera size={17} /> Activar cámara
          </Button>
        )}
      </div>
      {state.status === 'error' && (
        <p role="alert" className="error">
          {state.message}
        </p>
      )}
      <form
        className="scan-manual"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void controller.current?.lookup(code)
        }}
      >
        <Input
          label="Código de barras o etiqueta"
          autoFocus
          value={code}
          maxLength={128}
          required
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Escribe el código o usa tu lector USB"
        />
        <Button type="submit" disabled={busy}>
          {manufacturer ? 'Usar código' : 'Buscar código'}
        </Button>
      </form>
    </Dialog>
  )
}
