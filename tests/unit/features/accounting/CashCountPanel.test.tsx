import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessContext } from '@/app/AccessContext'
import { CashCountPanel } from '@/features/accounting/CashCountPanel'
import { emptyCashflow } from '@/features/accounting/cashflow'
import { localDay } from '@/features/reports/model'

const { financeService, settingsService } = vi.hoisted(() => ({
  financeService: {
    getCashflow: vi.fn(),
    getCashClosings: vi.fn(),
    recordCashClosing: vi.fn(),
    voidCashClosing: vi.fn(),
  },
  settingsService: { getExchangeRate: vi.fn() },
}))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ financeService, settingsService }),
}))
const day = localDay(new Date())
const range = { from: day, to: day }
beforeEach(() => {
  financeService.getCashflow.mockResolvedValue({
    ...emptyCashflow,
    ...range,
    available: true,
    opening: { caja: 500, banco: 0 },
    closing: { caja: 500, banco: 0 },
  })
  financeService.getCashClosings.mockResolvedValue([])
  financeService.recordCashClosing.mockReset().mockResolvedValue('close-id')
  settingsService.getExchangeRate.mockResolvedValue({ usdToNio: 36.6 })
})
function show(demo = false) {
  const changed = vi.fn()
  render(
    <AccessContext.Provider value={{ base: '', demo, role: 'admin' }}>
      <CashCountPanel range={range} onChanged={changed} />
    </AccessContext.Provider>,
  )
  return changed
}

it('saves denomination counts using the explicit rate without changing expected cash', async () => {
  const changed = show()
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('C$ 100 · cantidad'), '2')
  await user.type(screen.getByLabelText('US$ 10 · cantidad'), '1')
  const rate = screen.getByLabelText('Tasa del dólar para el arqueo')
  await user.clear(rate)
  await user.type(rate, '30')
  await user.click(screen.getByRole('button', { name: 'Guardar arqueo' }))
  await waitFor(() =>
    expect(financeService.recordCashClosing).toHaveBeenCalledOnce(),
  )
  expect(financeService.recordCashClosing).toHaveBeenCalledWith(
    expect.objectContaining({
      closedOn: day,
      countedNio: 200,
      countedUsd: 10,
      exchangeRate: 30,
      note: '',
      requestId: expect.any(String),
    }),
  )
  expect(changed).toHaveBeenCalledOnce()
}, 15000)

it('requires a reason for a difference and rejects negative or fractional counts', async () => {
  show()
  const user = userEvent.setup()
  const count = await screen.findByLabelText('C$ 100 · cantidad')
  await user.type(count, '1')
  const save = screen.getByRole('button', { name: 'Guardar arqueo' })
  expect(save).toBeDisabled()
  await user.type(
    screen.getByLabelText('Observación o motivo de diferencia'),
    'Faltante por conciliar',
  )
  expect(save).toBeEnabled()
  await user.clear(count)
  await user.type(count, '1.5')
  expect(save).toBeDisabled()
  await user.clear(count)
  await user.type(count, '-1')
  expect(save).toBeDisabled()
  expect(financeService.recordCashClosing).not.toHaveBeenCalled()
}, 15000)

it('keeps the closing pending without an opening or in the demonstration', async () => {
  financeService.getCashflow.mockResolvedValue({
    ...emptyCashflow,
    ...range,
    available: true,
  })
  show(true)
  expect(
    await screen.findByRole('button', { name: 'Guardar arqueo' }),
  ).toBeDisabled()
  expect(screen.getByText(/Registra el saldo inicial de caja/)).toBeVisible()
  expect(financeService.recordCashClosing).not.toHaveBeenCalled()
})

it('preserves the recorded expectation and flags later changes', async () => {
  financeService.getCashClosings.mockResolvedValue([
    {
      id: 'close',
      closedOn: day,
      countedNio: 500,
      countedUsd: 0,
      exchangeRate: null,
      countedTotalNio: 500,
      expectedNio: 500,
      differenceNio: 0,
      note: '',
      createdAt: `${day}T12:00:00Z`,
      voidedAt: null,
      voidReason: null,
      currentExpectedNio: 550,
      currentMissingSales: 0,
      changed: true,
    },
  ])
  show()
  expect(
    await screen.findByText(/Los registros cambiaron después del arqueo/),
  ).toBeVisible()
  expect(
    screen.getByRole('table', { name: 'Arqueos guardados' }),
  ).toHaveTextContent('NIO 500.00')
  expect(screen.getByRole('button', { name: 'Guardar arqueo' })).toBeDisabled()
})

it('allows counting known cash when an incomplete bank sale leaves bank pending', async () => {
  financeService.getCashflow.mockResolvedValue({
    ...emptyCashflow,
    ...range,
    available: true,
    closing: { caja: 500, banco: null },
    missingSales: 1,
  })
  show()
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('C$ 500 · cantidad'), '1')
  expect(screen.getByRole('button', { name: 'Guardar arqueo' })).toBeEnabled()
})
