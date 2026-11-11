import { Button, Select } from '../../components/ui'
import type { useInventoryAdjustmentAccounting } from './useInventoryAdjustmentAccounting'

export function InventoryAdjustmentAccounting({
  accounting,
}: {
  accounting: ReturnType<typeof useInventoryAdjustmentAccounting>
}) {
  return (
    <>
      <Select
        label="Tratamiento del ajuste"
        value={accounting.kind}
        onChange={(event) =>
          accounting.setKind(event.target.value as 'correction' | 'loss')
        }
      >
        <option value="correction">Corrección de cantidad (sin pérdida)</option>
        <option value="loss" disabled={!accounting.canRecordLoss}>
          Pérdida real
        </option>
      </Select>
      <Select
        label="Cuenta de contrapartida"
        required
        value={accounting.counterAccount}
        disabled={accounting.loading || !!accounting.error}
        onChange={(event) => accounting.setCounterAccount(event.target.value)}
      >
        <option value="">
          {accounting.loading
            ? 'Cargando cuentas…'
            : 'Selecciona la cuenta de contrapartida'}
        </option>
        {accounting.accounts.map((account) => (
          <option
            key={account.code}
            value={account.code}
            disabled={account.code === '5150' && !accounting.canRecordLoss}
          >
            {account.displayCode ?? account.code} · {account.name}
          </option>
        ))}
      </Select>
      {accounting.kind === 'correction' ? (
        <>
          <p className="muted">
            La corrección cambia la cantidad y el valor del inventario contra la
            cuenta elegida, sin registrar ingresos, costos ni gastos. Para
            acumular estos ajustes fuera del estado de resultados, elige una
            cuenta de orden creada en Contabilidad → Catálogo de cuentas.
          </p>
          {!accounting.loading &&
            !accounting.error &&
            !accounting.accounts.length && (
              <p role="status">
                No hay cuentas de orden, activo, pasivo o capital disponibles
                para este ajuste. Activa o agrega la cuenta correspondiente en
                Contabilidad.
              </p>
            )}
        </>
      ) : (
        <>
          <p className="muted">
            La reducción se reconocerá como una pérdida real de inventario. Este
            tratamiento solo permite disminuir las existencias.
          </p>
        </>
      )}
      {accounting.error && (
        <>
          <p role="alert" className="inline-error">
            {accounting.error}
          </p>
          <Button type="button" variant="secondary" onClick={accounting.retry}>
            Actualizar cuentas
          </Button>
        </>
      )}
    </>
  )
}
