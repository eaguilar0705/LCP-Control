import { formatDate } from '../../lib/format'
import { Button } from '../../components/ui'
import '../../styles/payment-date.css'

export function PaymentDateConfirmation({
  date,
  confirmed,
  onConfirm,
  onToday,
}: {
  date: string
  confirmed: boolean
  onConfirm: (value: boolean) => void
  onToday: () => void
}) {
  return (
    <div className="payment-date-confirmation">
      <p>Este pago corresponde al {formatDate(date)} y no al arqueo de hoy.</p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirm(event.target.checked)}
        />
        <span>Confirmo que el dinero se movió el {formatDate(date)}.</span>
      </label>
      <Button type="button" variant="secondary" onClick={onToday}>
        El pago se hizo hoy
      </Button>
    </div>
  )
}
