import { Button, Input, Select } from '../../components/ui'
import { formatCurrency } from '../../lib/format'
import { labels, type Currency, type InvoicePayment } from '../../lib/domain'
import { paymentsNio } from './splitPaymentModel'
export function SplitPayments({
  value,
  onChange,
  total,
  currency,
  rate,
}: {
  value: InvoicePayment[]
  onChange: (next: InvoicePayment[]) => void
  total: number | null
  currency: Currency
  rate: number
}) {
  const converted = paymentsNio(value)
  const amountsReady = Number.isFinite(converted)
  const expected = Math.round((total ?? 0) * rate * 100) / 100
  function change(index: number, patch: Partial<InvoicePayment>) {
    onChange(value.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }
  return (
    <section className="split-payments" aria-label="Pagos divididos">
      <div className="form-actions">
        <strong>Pagos divididos</strong>
        <Button type="button" variant="ghost" onClick={() => onChange([])}>
          Usar un solo pago
        </Button>
      </div>
      {value.map((p, index) => (
        <div className="split-payment-row" key={index}>
          <Select
            label={`Pago ${index + 1}`}
            value={p.method}
            onChange={(e) =>
              change(index, {
                method: e.target.value as InvoicePayment['method'],
              })
            }
          >
            {Object.entries(labels.payment).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            label="Moneda del pago"
            value={p.currency}
            onChange={(e) =>
              change(index, {
                currency: e.target.value as Currency,
                exchangeRate:
                  e.target.value === 'NIO' ? 1 : rate === 1 ? 0 : rate,
              })
            }
          >
            <option value="NIO">C$</option>
            <option value="USD">US$</option>
          </Select>
          <Input
            label="Importe recibido"
            type="number"
            min="0.01"
            step="0.01"
            value={p.amount || ''}
            onChange={(e) => change(index, { amount: Number(e.target.value) })}
          />
          {p.currency === 'USD' && (
            <Input
              label="NIO por 1 USD"
              type="number"
              min="0.000001"
              step="0.000001"
              value={p.exchangeRate || ''}
              onChange={(e) =>
                change(index, { exchangeRate: Number(e.target.value) })
              }
            />
          )}
          {value.length > 2 && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Quitar pago {index + 1}
            </Button>
          )}
        </div>
      ))}
      <div className="form-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={value.length >= 10}
          onClick={() =>
            onChange([
              ...value,
              { method: 'cash', currency, amount: 0, exchangeRate: rate },
            ])
          }
        >
          Agregar pago
        </Button>
        <span role="status">
          {amountsReady ? (
            <>
              Recibido: {formatCurrency(converted, 'NIO')} · Faltan:{' '}
              {formatCurrency(Math.max(0, expected - converted), 'NIO')}
            </>
          ) : (
            'Completa los importes y tipos de cambio.'
          )}
        </span>
      </div>
    </section>
  )
}
