import { Input, Select } from '../../components/ui'
import type { Currency } from '../../lib/domain'
import { purchaseBanks } from '../pricing/purchaseService'
import type { FreightPayment } from '@lcp/contracts/inventoryReceipts'

export function FreightPaymentFields({
  currency,
  shipping,
  rate,
  value,
  onChange,
  reviewing,
}: {
  currency: Currency
  shipping: number
  rate: number | null
  value: FreightPayment
  onChange: (payment: FreightPayment) => void
  reviewing?: boolean
}) {
  const accounts = [
    { code: '1110-001', name: 'Caja C$', currency: 'NIO' },
    { code: '1110-002', name: 'Caja US$', currency: 'USD' },
    ...purchaseBanks,
  ]
  const dollarAccount = accounts.some(
    (account) => account.code === value.account && account.currency === 'USD',
  )
  function selectAccount(code: string) {
    const needsRate =
      currency === 'NIO' &&
      accounts.some(
        (account) => account.code === code && account.currency === 'USD',
      )
    onChange({
      account: code,
      reference: '',
      ...(needsRate && rate && { exchangeRate: rate }),
    })
  }
  return (
    <>
      <Select
        label="Método de pago del flete"
        value={value.account}
        onChange={(event) => selectAccount(event.target.value)}
      >
        <option value="">
          {reviewing
            ? 'Seleccionar pago del flete'
            : 'Por definir en Contabilidad'}
        </option>
        <option value="included">Incluido en el pago de la mercadería</option>
        {accounts.map((account) => (
          <option key={account.code} value={account.code}>
            {account.name}
          </option>
        ))}
      </Select>
      {currency === 'NIO' && dollarAccount && (
        <div>
          <Input
            label="Tasa del pago del flete (C$ por US$)"
            type="number"
            min={0.000001}
            step={0.000001}
            value={value.exchangeRate ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                exchangeRate: Number(event.target.value) || undefined,
              })
            }
          />
          {value.exchangeRate && value.exchangeRate > 0 ? (
            <small>
              Pago equivalente: US$ {(shipping / value.exchangeRate).toFixed(2)}
            </small>
          ) : null}
        </div>
      )}
      {value.account && value.account !== 'included' && (
        <Input
          label="Referencia del pago del flete (opcional)"
          maxLength={200}
          value={value.reference}
          onChange={(event) =>
            onChange({ ...value, reference: event.target.value })
          }
        />
      )}
    </>
  )
}
