import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Camera, ScanLine, ShieldCheck, Keyboard, X } from 'lucide-react'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { createHtml5Adapter } from './html5Adapter'
import { ScannerSession, type ScanState } from './ScannerSession'
import { useServices } from '../../services/useServices'
import { ScannerResult, UnknownProduct } from './ScannerResult'
export function ScannerPage() {
  const { productService } = useServices()
  const id = useId().replaceAll(':', '')
  const elementId = `camera-${id}`
  const controller = useRef<ScannerSession | null>(null)
  const [state, setState] = useState<ScanState>({ status: 'idle' })
  useEffect(() => {
    let active = true
    const session = new ScannerSession(
      createHtml5Adapter(elementId),
      productService.findByBarcode,
      (state) => {
        if (active) setState(state)
      },
    )
    controller.current = session
    return () => {
      active = false
      void session.cancel()
      controller.current = null
    }
  }, [elementId, productService])
  async function cancel() {
    await controller.current?.cancel()
    setState({ status: 'idle' })
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void controller.current?.lookup(String(data.get('barcode') ?? ''))
  }
  const cameraActive =
    state.status === 'scanning' || state.status === 'starting'
  const busy = cameraActive || state.status === 'looking'
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">LECTOR DE PRODUCTOS</span>
          <h1>Escanear producto</h1>
        </div>
      </div>
      <div className="scanner-grid">
        <Card className="scanner-panel">
          <div className="section-heading">
            <h2>
              <ScanLine size={19} /> Lector de códigos
            </h2>
            <span className="badge badge-neutral">QR / Barras</span>
          </div>
          <div
            className={`camera-stage ${cameraActive ? 'camera-active' : ''}`}
          >
            <div id={elementId} className="camera-reader" />
            {!cameraActive && (
              <div className="camera-placeholder">
                <div className="scan-frame">
                  <Camera size={45} strokeWidth={1} />
                </div>
                <h3>Acerca el código a la cámara</h3>
              </div>
            )}
            {state.status === 'starting' && (
              <div className="camera-loading" role="status">
                Solicitando acceso a la cámara…
              </div>
            )}
          </div>
          <div className="scanner-controls">
            {cameraActive ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void cancel()
                }}
              >
                <X size={17} /> Detener cámara
              </Button>
            ) : (
              <Button
                onClick={() => {
                  void controller.current?.start()
                }}
                disabled={state.status === 'looking'}
              >
                <Camera size={18} />
                {state.status === 'idle'
                  ? 'Iniciar cámara'
                  : 'Escanear de nuevo'}
              </Button>
            )}
            <span>
              <ShieldCheck size={14} /> La cámara solo se usa para leer códigos.
            </span>
          </div>
          {state.status === 'error' && (
            <ErrorState
              message={state.message}
              retry={() => {
                void controller.current?.start()
              }}
            />
          )}
          <div className="manual-scan">
            <h3>
              <Keyboard size={17} /> ¿Tienes el código a mano?
            </h3>
            <form onSubmit={search}>
              <Input
                label="Código del producto"
                name="barcode"
                placeholder="Código de barras"
                maxLength={128}
                required
                disabled={busy}
              />
              <Button variant="secondary" type="submit" disabled={busy}>
                Buscar
              </Button>
            </form>
          </div>
        </Card>
        <div>
          {state.status === 'found' ? (
            <ScannerResult product={state.product} />
          ) : state.status === 'unknown' ? (
            <UnknownProduct code={state.code} />
          ) : state.status === 'looking' ? (
            <Card>
              <LoadingState />
            </Card>
          ) : (
            <Card className="scanner-guide">
              <span className="eyebrow">ASÍ DE SIMPLE</span>
              <h2>Del código al producto.</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <h3>Activa tu cámara</h3>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <h3>Apunta al código</h3>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <h3>Consulta y continúa</h3>
                  </div>
                </li>
              </ol>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
