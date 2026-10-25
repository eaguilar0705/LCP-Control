import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ConfirmDialog } from './ui'
import { errorMessage } from '../lib/errors'
import {
  forgetOperationReference,
  operationLabels,
  type OperationReference,
} from '../lib/operationRecovery'
import { operationConfirmation } from '../services/operationRecovery'

const referenceKey = (reference: OperationReference) =>
  `${reference.kind}:${reference.requestId}`
export function OperationRecoveryBanner({
  references,
  base,
  onConfirmed,
}: {
  references: OperationReference[]
  base: string
  onConfirmed: () => void
}) {
  const [checking, setChecking] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [retiring, setRetiring] = useState<OperationReference | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function verify(reference: OperationReference, retire = false) {
    if (checking) return
    const key = referenceKey(reference)
    setChecking(key)
    setError('')
    setMessage('')
    try {
      const result = await operationConfirmation(reference, retire)
      if (result.status === 'missing') {
        setMissing((current) => [...new Set([...current, key])])
      } else {
        forgetOperationReference(
          reference.scope,
          reference.kind,
          reference.requestId,
        )
        setMissing((current) => current.filter((value) => value !== key))
        setRetiring(null)
        setMessage(
          result.status === 'retired'
            ? 'Solicitud descartada. Puedes registrar la operación de nuevo.'
            : `${operationLabels[reference.kind]}${result.number ? ` ${result.number}` : ''}: guardado confirmado${result.cancelled ? ' (anulado)' : ''}. Consulta el historial.`,
        )
        onConfirmed()
      }
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setChecking(null)
    }
  }
  return (
    <>
      {references.length > 0 && (
        <aside
          className="sales-pending-banner no-print"
          role="status"
          aria-label="Solicitudes por recuperar"
        >
          <strong>Hay guardados pendientes de confirmar.</strong>
          {references.map((reference) => {
            const key = referenceKey(reference)
            const inventoryModule = [
              'purchase',
              'purchase-correction',
              'opening-cost',
              'price-tier-create',
              'price-list-prices',
            ].includes(reference.kind)
            const history =
              reference.kind === 'proforma'
                ? '/proformas/history'
                : ['invoice', 'sales-return'].includes(reference.kind)
                  ? '/sales/history'
                  : ['inventory-movement', 'inventory-transfer'].includes(
                        reference.kind,
                      )
                    ? '/inventory/history'
                    : inventoryModule
                      ? '/inventory'
                      : reference.kind === 'business-import'
                        ? '/settings'
                        : reference.kind.startsWith('business-day-')
                          ? '/'
                          : '/accounting'
            return (
              <div className="pending-operation-row" key={key}>
                <div>
                  <strong>{operationLabels[reference.kind]}</strong>
                  <small>Solicitud {reference.requestId}</small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={checking !== null}
                  onClick={() => void verify(reference)}
                >
                  {checking === key ? 'Consultando…' : 'Consultar guardado'}
                </Button>
                <Link to={`${base}${history}`}>
                  {inventoryModule
                    ? 'Ver inventario'
                    : reference.kind === 'business-import'
                      ? 'Ver Negocio'
                      : 'Consultar historial'}
                </Link>
                {missing.includes(key) && (
                  <div>
                    <p>
                      No se encontró un guardado con este identificador. Revisa
                      el historial antes de registrar la operación de nuevo.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={checking !== null}
                      onClick={() => {
                        setError('')
                        setRetiring(reference)
                      }}
                    >
                      Descartar solicitud
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </aside>
      )}
      {message && !references.length && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={retiring !== null}
        title="Descartar solicitud no guardada"
        confirmLabel="Descartar solicitud"
        busy={checking !== null}
        error={error}
        onCancel={() => {
          if (!checking) {
            setRetiring(null)
            setError('')
          }
        }}
        onConfirm={() => {
          if (retiring) void verify(retiring, true)
        }}
      >
        {retiring && (
          <>
            <p>
              {operationLabels[retiring.kind]} · {retiring.requestId}
            </p>
            <p>
              Se volverá a comprobar el guardado. Si no existe, se bloqueará
              este identificador para impedir que un envío tardío duplique la
              operación. Después podrás registrarla de nuevo.
            </p>
            <p>
              Si ya se guardó mientras revisabas, se recuperará ese resultado y
              no se descartará.
            </p>
          </>
        )}
      </ConfirmDialog>
    </>
  )
}
