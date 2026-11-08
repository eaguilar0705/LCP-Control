import { useCallback, useState } from 'react'
import { useAccess } from '../../app/AccessContext'
import { AppError } from '../../lib/errors'
import { useQuery } from '../../lib/useQuery'
import { accountCurrency } from '../accounting/journalModel'
import { journalRpc } from '../accounting/journalService'

interface AdjustmentAccount {
  code: string
  displayCode?: string
  name: string
  bucket: string
  postable: boolean
  active: boolean
}
type AdjustmentKind = 'correction' | 'loss'

export function useInventoryAdjustmentAccounting(
  contextKey: string,
  enabled: boolean,
  before: number | null,
  after: number | null,
) {
  const { role, demo } = useAccess()
  const load = useCallback(async () => {
    if (!enabled || role !== 'superadmin' || demo) return []
    const accounts = await journalRpc<AdjustmentAccount[]>(
      'ledger_accounts_list',
      {},
    )
    if (
      !Array.isArray(accounts) ||
      accounts.some(
        (a) =>
          !a ||
          typeof a.code !== 'string' ||
          typeof a.name !== 'string' ||
          typeof a.bucket !== 'string' ||
          typeof a.postable !== 'boolean' ||
          typeof a.active !== 'boolean',
      )
    )
      throw new AppError(
        'unexpected',
        'No se recibió la lista completa de cuentas. Vuelve a consultar.',
      )
    return accounts
  }, [enabled, role, demo])
  const query = useQuery(load)
  const [selection, setSelection] = useState({
    contextKey,
    kind: 'correction' as AdjustmentKind,
    counterAccount: '',
  })
  const current =
    selection.contextKey === contextKey
      ? selection
      : { contextKey, kind: 'correction' as const, counterAccount: '' }
  const accounts = (query.data ?? []).filter(
    (a) =>
      a.active &&
      a.postable &&
      (a.code === '5150' ||
        (['asset', 'liability', 'equity'].includes(a.bucket) &&
          a.code !== '1130' &&
          accountCurrency(a.code) !== 'USD')),
  )
  const canRecordLoss =
    before !== null && after !== null && after >= 0 && after < before
  const valid =
    !enabled ||
    (!query.loading &&
      !query.error &&
      accounts.some((a) => a.code === current.counterAccount) &&
      (current.kind === 'loss'
        ? current.counterAccount === '5150' && canRecordLoss
        : current.counterAccount !== '5150'))
  return {
    ...current,
    accounts,
    lossAccount: query.data?.find((a) => a.code === '5150'),
    loading: query.loading,
    error: query.error,
    retry: query.retry,
    valid,
    canRecordLoss,
    setKind: (kind: AdjustmentKind) =>
      setSelection({
        contextKey,
        kind,
        counterAccount: kind === 'loss' ? '5150' : '',
      }),
    setCounterAccount: (counterAccount: string) =>
      setSelection({
        contextKey,
        kind: counterAccount === '5150' ? 'loss' : 'correction',
        counterAccount,
      }),
    reset: () =>
      setSelection({ contextKey, kind: 'correction', counterAccount: '' }),
  }
}
