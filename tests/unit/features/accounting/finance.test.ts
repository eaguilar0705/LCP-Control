import { describe, expect, it } from 'vitest'
import {
  emptySales,
  financeLedger,
  financePosition,
  salesByPayment,
  type FinanceEntryRecord,
  type PaidExpense,
} from '@/features/accounting/finance'

const range = { from: '2026-09-01', to: '2026-09-30' }
let next = 0
const entry = (changes: Partial<FinanceEntryRecord>): FinanceEntryRecord => ({
  id: `e${++next}`,
  requestId: `r${next}`,
  occurredOn: '2026-09-01',
  kind: 'opening',
  account: 'caja',
  toAccount: null,
  amount: 100,
  currency: 'NIO',
  exchangeRate: 1,
  counterparty: '',
  description: '',
  reference: '',
  createdAt: '2026-09-01T12:00:00Z',
  voidedAt: null,
  voidReason: null,
  ...changes,
})
const expense = (changes: Partial<PaidExpense>): PaidExpense => ({
  id: `g${++next}`,
  requestId: `g${next}`,
  incurredOn: '2026-09-10',
  category: 'renta',
  description: 'Renta',
  amount: 50,
  currency: 'NIO',
  exchangeRate: 1,
  reference: '',
  account: 'caja',
  createdAt: '2026-09-10T12:00:00Z',
  voidedAt: null,
  voidReason: null,
  ...changes,
})

describe('financePosition', () => {
  it('sin saldo inicial no inventa saldos', () => {
    const ledger = financeLedger(
      { entries: [entry({ kind: 'capital' })], expenses: [], shipments: [], sales: emptySales },
      range,
    )
    expect(ledger.position.started).toBe(false)
    expect(ledger.position.cash.caja).toBe(0)
  })

  it('suma ventas, gastos, pedidos y movimientos desde el saldo inicial', () => {
    const ledger = financeLedger(
      {
        entries: [
          entry({ account: 'caja', amount: 1000 }),
          entry({ account: 'banco', amount: 5000 }),
          entry({ account: 'prestamos', amount: 3000 }),
          entry({ kind: 'transfer', account: 'caja', toAccount: 'banco', amount: 200, occurredOn: '2026-09-05' }),
          entry({ kind: 'loan', account: 'banco', amount: 2000, occurredOn: '2026-09-06' }),
          entry({ kind: 'collection', account: 'banco', amount: 300, occurredOn: '2026-09-07' }),
          entry({ kind: 'supplier_payment', account: 'banco', amount: 400, occurredOn: '2026-09-08' }),
          entry({ kind: 'withdrawal', account: 'caja', amount: 100, occurredOn: '2026-09-09' }),
          entry({ kind: 'capital', account: 'caja', amount: 50, occurredOn: '2026-09-09', voidedAt: '2026-09-09T13:00:00Z', voidReason: 'Error' }),
        ],
        expenses: [
          expense({ account: 'caja', amount: 80 }),
          expense({ account: 'banco', category: 'prestamo_bancario', amount: 500 }),
          // Anterior al saldo inicial: no cuenta.
          expense({ incurredOn: '2026-08-20', amount: 999 }),
        ],
        shipments: [
          { incurredOn: '2026-09-12', amountNio: 700, account: 'banco' },
          { incurredOn: '2026-09-13', amountNio: 900, account: 'credito' },
        ],
        sales: { caja: 1500, banco: 2500, cobrar: 600, missing: 1 },
      },
      range,
    )
    const { position } = ledger
    expect(position.startOn).toBe('2026-09-01')
    // 1000 − 200 − 100 − 80 + 1500
    expect(position.cash.caja).toBe(2120)
    // 5000 + 200 + 2000 + 300 − 400 − 500 − 700 + 2500
    expect(position.cash.banco).toBe(8400)
    expect(position.receivablesNio).toBe(300)
    // 3000 + 2000 − 500
    expect(position.loansNio).toBe(4500)
    // 900 − 400
    expect(position.payablesNio).toBe(500)
    // 1000 + 5000 − 3000 − 100
    expect(position.capitalNio).toBe(2900)
    expect(position.missingSales).toBe(1)
    // La lista sólo trae lo del período.
    expect(ledger.expenses).toHaveLength(2)
  })

  it('convierte los dólares con el tipo de cambio de cada movimiento', () => {
    const position = financePosition({
      available: true,
      startOn: '2026-09-01',
      at: '2026-09-30',
      entries: [entry({ currency: 'USD', exchangeRate: 36.5, amount: 10 })],
      expenses: [],
      shipments: [],
      sales: emptySales,
    })
    expect(position.cash.caja).toBe(365)
  })
})

it('salesByPayment reparte por forma de pago', () => {
  expect(
    salesByPayment([
      { paymentMethod: 'cash', amountNio: 10 },
      { paymentMethod: 'pending', amountNio: 20 },
      { paymentMethod: 'bac_nio', amountNio: 30 },
      { paymentMethod: 'card_pos', amountNio: 5 },
      { paymentMethod: 'cash', amountNio: null },
    ]),
  ).toEqual({ caja: 10, banco: 35, cobrar: 20, missing: 1 })
})
