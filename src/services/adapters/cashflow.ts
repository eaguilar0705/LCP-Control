import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError } from '../../lib/errors'
import {
  cashflowCategories,
  emptyCashflow,
  type CashClosingInput,
  type CashClosingRecord,
  type CashflowBalances,
  type CashflowReport,
  type CashflowRow,
} from '../../features/accounting/cashflow'
import type { ReportRange } from '../../features/reports/model'
import { accountingSchemaMissing } from './accounting'

type DatabaseError = { code?: string; message?: string }
type Row = Record<string, unknown>
function number(value: unknown): number {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(Number(value))
  )
    throw new AppError(
      'unexpected',
      'El flujo de efectivo contiene un importe incompleto o inválido.',
    )
  return Number(value)
}
const nullable = (value: unknown) => (value === null ? null : number(value))
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(
      'unexpected',
      'No se recibió el resumen de caja completo.',
    )
  return value as Row
}
function balances(value: unknown): CashflowBalances {
  const row = object(value)
  return { caja: nullable(row.caja), banco: nullable(row.banco) }
}
function flowRow(value: unknown): CashflowRow {
  const row = object(value)
  if (
    (row.account !== 'caja' && row.account !== 'banco') ||
    typeof row.category !== 'string' ||
    !Object.hasOwn(cashflowCategories, row.category)
  )
    throw new AppError(
      'unexpected',
      'El flujo de efectivo contiene una cuenta o categoría inválida.',
    )
  return {
    day: String(row.day),
    account: row.account,
    category: row.category as CashflowRow['category'],
    inflowNio: number(row.inflowNio),
    outflowNio: number(row.outflowNio),
    operations: number(row.operations),
    missingSales: number(row.missingSales),
  }
}
function closingRow(value: unknown): CashClosingRecord {
  const row = object(value)
  return {
    id: String(row.id),
    requestId: String(row.requestId),
    closedOn: String(row.closedOn),
    countedNio: number(row.countedNio),
    countedUsd: number(row.countedUsd),
    exchangeRate: nullable(row.exchangeRate),
    countedTotalNio: number(row.countedTotalNio),
    expectedNio: number(row.expectedNio),
    differenceNio: number(row.differenceNio),
    note: String(row.note),
    createdAt: String(row.createdAt),
    voidedAt: row.voidedAt === null ? null : String(row.voidedAt),
    voidReason: row.voidReason === null ? null : String(row.voidReason),
    currentExpectedNio: nullable(row.currentExpectedNio),
    currentMissingSales: number(row.currentMissingSales),
    changed: row.changed === true,
  }
}

export function createCashflowAdapter(
  client: () => SupabaseClient,
  errorToApp: (error: DatabaseError | null) => AppError,
) {
  async function read(name: string, range: ReportRange) {
    const { data, error } = await client().rpc(name, {
      p_from: range.from,
      p_to: range.to,
    })
    if (error) {
      if (accountingSchemaMissing(error)) return null
      throw errorToApp(error)
    }
    return data as unknown
  }
  async function write(name: string, args: Record<string, unknown>) {
    const { data, error } = await client().rpc(name, args)
    if (error) {
      if (accountingSchemaMissing(error))
        throw new AppError(
          'configuration',
          'Falta aplicar la actualización de arqueo y flujo de efectivo en Supabase. Contacta al administrador.',
        )
      throw errorToApp(error)
    }
    if (typeof data !== 'string' || !data)
      throw new AppError(
        'unexpected',
        'No se recibió la confirmación del arqueo.',
      )
    return data
  }
  return {
    async getCashflow(range: ReportRange): Promise<CashflowReport> {
      const data = await read('finance_cashflow', range)
      if (data === null) return { ...structuredClone(emptyCashflow), ...range }
      const row = object(data)
      if (!Array.isArray(row.rows) || row.available !== true)
        throw new AppError(
          'unexpected',
          'No se recibió el flujo de efectivo completo.',
        )
      const totals = object(row.totals)
      return {
        available: true,
        from: String(row.from),
        to: String(row.to),
        startOn: row.startOn === null ? null : String(row.startOn),
        opening: balances(row.opening),
        closing: balances(row.closing),
        missingSales: number(row.missingSales),
        rows: row.rows.map(flowRow),
        totals: {
          inflowNio: number(totals.inflowNio),
          outflowNio: number(totals.outflowNio),
          netNio: number(totals.netNio),
        },
      }
    },
    async getCashClosings(range: ReportRange): Promise<CashClosingRecord[]> {
      const data = await read('list_cash_closings', range)
      if (data === null) return []
      if (!Array.isArray(data))
        throw new AppError(
          'unexpected',
          'No se recibió el historial de arqueos completo.',
        )
      return data.map(closingRow)
    },
    recordCashClosing: (input: CashClosingInput) =>
      write('record_cash_closing', { p_input: input }),
    voidCashClosing: (id: string, reason: string) =>
      write('void_cash_closing', { p_id: id, p_reason: reason }),
  }
}
