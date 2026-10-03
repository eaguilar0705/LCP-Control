import { beforeEach, expect, it, vi } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessContext } from '@/app/AccessContext'
import { AppError } from '@/lib/errors'
import { CreditAccounts } from '@/features/accounting/CreditAccounts'
import { RecordDialog } from '@/features/accounting/FinanceMovements'
import type { CreditAccount, CreditLedger } from '@/features/accounting/finance'
import { localDay } from '@/features/reports/model'
import {
  syntheticCredits,
  syntheticFinance,
  syntheticCashflow,
} from '@/services/adapters/catalogSales'

const { financeService, settingsService, accountingService } = vi.hoisted(
  () => ({
    financeService: {
      getCredits: vi.fn(),
      recordEntry: vi.fn(),
      voidEntry: vi.fn(),
    },
    settingsService: {
      getExchangeRate: vi.fn(async () => ({ usdToNio: 37, updatedAt: null })),
    },
    accountingService: { recordExpense: vi.fn() },
  }),
)
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ financeService, settingsService, accountingService }),
}))

const today = localDay(new Date())
const invoice: CreditAccount = {
  id: 'invoice:1',
  kind: 'receivable',
  counterparty: 'María Díaz',
  reference: 'FAC-001',
  occurredOn: '2026-01-05',
  originalNio: 1000,
  paidNio: 260,
  balanceNio: 740,
  documentId: 'invoice-1',
  shipmentId: null,
}
const shipment: CreditAccount = {
  id: 'shipment:1',
  kind: 'payable',
  counterparty: 'Importadora Ámbar',
  reference: 'PED-101',
  occurredOn: '2026-01-06',
  originalNio: 3000,
  paidNio: 0,
  balanceNio: 3000,
  documentId: null,
  shipmentId: 'shipment-1',
}
function ledger(changes: Partial<CreditLedger> = {}): CreditLedger {
  return {
    available: true,
    at: today,
    startOn: '2026-01-01',
    rows: [invoice, shipment],
    legacyPayments: 0,
    unallocatedNio: { receivables: 0, payables: 0 },
    ...changes,
  }
}
function renderWithAccess(content: React.ReactNode, demo = false) {
  return render(
    <AccessContext.Provider value={{ base: '', demo, role: 'admin' }}>
      {content}
    </AccessContext.Provider>,
  )
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  financeService.getCredits.mockReset()
  financeService.getCredits.mockImplementation(async (at: string) =>
    ledger({ at }),
  )
  financeService.recordEntry.mockReset()
  financeService.recordEntry.mockResolvedValue('new-payment')
})

it('records a linked invoice installment in dollars and refreshes the ledger', async () => {
  const changed = vi.fn()
  renderWithAccess(<CreditAccounts ledger={ledger()} onChanged={changed} />)
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Registrar abono a FAC-001' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Registrar abono' })
  await waitFor(() =>
    expect(within(dialog).getByLabelText('Cliente')).toHaveValue('María Díaz'),
  )
  expect(within(dialog).getByLabelText('Tipo')).toBeDisabled()
  expect(within(dialog).getByLabelText('Factura o saldo inicial')).toHaveValue(
    'invoice:1',
  )
  await user.selectOptions(within(dialog).getByLabelText('Moneda'), 'USD')
  await user.type(within(dialog).getByLabelText('Importe (USD)'), '10')
  await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(financeService.recordEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: expect.any(String),
      kind: 'collection',
      account: 'caja',
      amount: 10,
      currency: 'USD',
      exchangeRate: 37,
      counterparty: 'María Díaz',
      documentId: 'invoice-1',
      shipmentId: null,
    }),
  )
  expect(await screen.findByText('Abono registrado.')).toBeVisible()
}, 15000)

it('prevents a payment exceeding the linked debt after currency conversion', async () => {
  renderWithAccess(
    <RecordDialog
      initialCredit={invoice}
      onClose={vi.fn()}
      onRecorded={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled(),
  )
  await user.selectOptions(screen.getByLabelText('Moneda'), 'USD')
  await user.type(screen.getByLabelText('Importe (USD)'), '21')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'El abono supera el saldo pendiente',
  )
  expect(financeService.recordEntry).not.toHaveBeenCalled()
})

it('requires selecting a supplier order and keeps the supplier linked to it', async () => {
  renderWithAccess(
    <RecordDialog
      initialKind="supplier_payment"
      onClose={vi.fn()}
      onRecorded={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  await screen.findByRole('option', { name: /PED-101/ })
  expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  await user.selectOptions(
    screen.getByLabelText('Pedido o saldo inicial'),
    shipment.id,
  )
  expect(screen.getByLabelText('Proveedor')).toHaveValue('Importadora Ámbar')
  expect(screen.getByLabelText('Proveedor')).toHaveAttribute('readonly')
  await user.type(screen.getByLabelText('Importe (NIO)'), '500')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  await waitFor(() => expect(financeService.recordEntry).toHaveBeenCalledOnce())
  expect(financeService.recordEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'supplier_payment',
      documentId: null,
      shipmentId: 'shipment-1',
      amount: 500,
    }),
  )
})

it('disables settled or unknown balances and supports search and account type filters', async () => {
  const settled = {
    ...invoice,
    id: 'invoice:2',
    reference: 'FAC-002',
    paidNio: 1000,
    balanceNio: 0,
  }
  const unknown = {
    ...invoice,
    id: 'invoice:3',
    reference: 'FAC-003',
    originalNio: null,
    paidNio: null,
    balanceNio: null,
  }
  renderWithAccess(
    <CreditAccounts
      ledger={ledger({ rows: [invoice, shipment, settled, unknown] })}
      onChanged={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  expect(screen.queryByText('FAC-002')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Registrar abono a FAC-003' }),
  ).toBeDisabled()
  await user.selectOptions(screen.getByLabelText('Estado de cuenta'), 'all')
  expect(
    screen.getByRole('button', { name: 'Registrar abono a FAC-002' }),
  ).toBeDisabled()
  await user.selectOptions(screen.getByLabelText('Tipo de cuenta'), 'payable')
  await user.type(
    screen.getByLabelText('Cliente, proveedor o referencia'),
    'ambar',
  )
  expect(screen.getByText('PED-101')).toBeVisible()
  expect(screen.queryByText('FAC-001')).not.toBeInTheDocument()
})

it('rejects writes in the demo and reports a missing database update', () => {
  const view = renderWithAccess(
    <CreditAccounts ledger={ledger()} onChanged={vi.fn()} />,
    true,
  )
  expect(
    screen.getByRole('button', { name: 'Registrar abono a FAC-001' }),
  ).toBeDisabled()
  view.unmount()
  renderWithAccess(
    <CreditAccounts
      ledger={ledger({ available: false })}
      onChanged={vi.fn()}
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'actualización de cuentas por cobrar y pagar',
  )
})

it('preserves the installment request identity when retrying a failed save', async () => {
  financeService.recordEntry.mockRejectedValueOnce(
    new AppError('network', 'Conexión interrumpida'),
  )
  renderWithAccess(
    <RecordDialog
      initialCredit={invoice}
      onClose={vi.fn()}
      onRecorded={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled(),
  )
  await user.type(screen.getByLabelText('Importe (NIO)'), '300')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Conexión interrumpida',
  )
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  await waitFor(() =>
    expect(financeService.recordEntry).toHaveBeenCalledTimes(2),
  )
  expect(financeService.recordEntry.mock.calls[0][0].requestId).toBe(
    financeService.recordEntry.mock.calls[1][0].requestId,
  )
})

it('blocks saving with a stale balance while an earlier cutoff is loading', async () => {
  renderWithAccess(
    <RecordDialog
      initialCredit={invoice}
      onClose={vi.fn()}
      onRecorded={vi.fn()}
    />,
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled(),
  )
  let finishRead!: (value: CreditLedger) => void
  financeService.getCredits.mockImplementationOnce(
    () =>
      new Promise<CreditLedger>((resolve) => {
        finishRead = resolve
      }),
  )
  fireEvent.change(screen.getByLabelText('Fecha'), {
    target: { value: '2026-01-04' },
  })
  expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  await waitFor(() =>
    expect(financeService.getCredits).toHaveBeenCalledWith('2026-01-04'),
  )
  finishRead(ledger({ at: '2026-01-04', rows: [] }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'no está disponible en la fecha elegida',
  )
  expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  expect(financeService.recordEntry).not.toHaveBeenCalled()
})

it('allows an explicit zero opening balance without allowing zero installments', async () => {
  renderWithAccess(
    <RecordDialog
      initialKind="opening"
      onClose={vi.fn()}
      onRecorded={vi.fn()}
    />,
  )
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Importe (NIO)'), '0')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  await waitFor(() => expect(financeService.recordEntry).toHaveBeenCalledOnce())
  expect(financeService.recordEntry).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'opening', amount: 0 }),
  )
})

it('keeps the synthetic invoice and supplier balances reconciled with the finance ledger', () => {
  const at = '2026-10-03'
  const credits = syntheticCredits(at, at)
  const finance = syntheticFinance({ from: '2025-10-04', to: at }, at)
  const sum = (kind: CreditAccount['kind']) =>
    Math.round(
      credits.rows
        .filter((row) => row.kind === kind)
        .reduce((total, row) => total + (row.balanceNio ?? 0), 0) * 100,
    ) / 100
  expect(sum('receivable')).toBe(finance.position.receivablesNio)
  expect(sum('payable')).toBe(finance.position.payablesNio)
  expect(credits.rows.some((row) => (row.paidNio ?? 0) > 0)).toBe(true)
  expect(credits.rows.every((row) => (row.balanceNio ?? 0) >= 0)).toBe(true)
})

it('reconciles demo cashflow opening, movements and closing with cash and bank balances', () => {
  const at = '2026-10-03'
  const range = { from: '2026-09-04', to: at }
  const cashflow = syntheticCashflow(range, at)
  const ledger = syntheticFinance(range, at)
  expect(cashflow.closing).toEqual(ledger.position.cash)
  const difference =
    Math.round(
      (cashflow.closing.caja! +
        cashflow.closing.banco! -
        (cashflow.opening.caja! + cashflow.opening.banco!)) *
        100,
    ) / 100
  expect(cashflow.totals.netNio).toBe(difference)
  const byAccount = (account: 'caja' | 'banco') =>
    Math.round(
      (cashflow.opening[account]! +
        cashflow.rows
          .filter((row) => row.account === account)
          .reduce((sum, row) => sum + row.inflowNio - row.outflowNio, 0)) *
        100,
    ) / 100
  expect(byAccount('caja')).toBe(cashflow.closing.caja)
  expect(byAccount('banco')).toBe(cashflow.closing.banco)
  expect(ledger.position.openedAccounts).toHaveLength(5)
})
