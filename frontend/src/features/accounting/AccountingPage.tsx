import { useCallback, useMemo, useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { adjustRange, localDay } from '../reports/model'
import { accountingViews } from './accountingModel'
import { AccountingTables, AccountCatalog } from './AccountingTables'
import { readLedger } from './journalService'
import { journalModel } from './journalModel'
import { JournalWorkspace, AccountEditor } from './JournalWorkspace'
import { emptyLedger } from './finance'
import { CreditWorkspace } from './CreditWorkspace'
import '../../styles/accounting.css'
import '../../styles/business-day.css'

const views = {
  journal: 'Comprobantes',
  credits: 'Cobros y pagos',
  ...accountingViews,
}
export function AccountingPage() {
  const { salesService } = useServices()
  const [view, setView] = useState<keyof typeof views>('journal')
  const [range, setRange] = useState(() => {
    const today = localDay(new Date())
    return { from: today.slice(0, 7) + '-01', to: today }
  })
  const load = useCallback(async () => {
    const [ledger, business] = await Promise.all([
      readLedger(range.from, range.to),
      salesService.getBusiness(),
    ])
    return { ledger, name: business?.name ?? 'La Casa del Perfume' }
  }, [range, salesService])
  const { data, error, loading, retry, refresh } = useQuery(load)
  const model = useMemo(
    () => (data ? journalModel(data.ledger, data.name) : null),
    [data],
  )
  const current =
    data?.ledger.from === range.from && data.ledger.to === range.to
  const [exporting, setExporting] = useState(false),
    [failure, setFailure] = useState('')
  async function download() {
    if (!model || !current) return
    setExporting(true)
    setFailure('')
    try {
      const { accountingWorkbook } = await import('./accountingWorkbook')
      accountingWorkbook(model)
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>Contabilidad</h1>
      </div>
      <nav
        className="accounting-tabs accounting-tabs-standalone"
        aria-label="Secciones de contabilidad"
      >
        {(Object.keys(views) as (keyof typeof views)[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {views[id]}
          </button>
        ))}
      </nav>
      <Card className="report-filters">
        <div className="filter-grid">
          <Input
            label="Desde"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => {
              if (e.target.value) {
                const day =
                  e.target.value > localDay(new Date())
                    ? localDay(new Date())
                    : e.target.value
                setRange((current) => adjustRange(current, 'from', day))
              }
            }}
          />
          <Input
            label="Hasta"
            type="date"
            value={range.to}
            min={range.from}
            max={localDay(new Date())}
            onChange={(e) => {
              if (e.target.value) {
                const day =
                  e.target.value > localDay(new Date())
                    ? localDay(new Date())
                    : e.target.value
                setRange((current) => adjustRange(current, 'to', day))
              }
            }}
          />
          <div className="period-export">
            <Button
              variant="secondary"
              disabled={!model || !current || exporting}
              onClick={() => void download()}
            >
              <FileSpreadsheet size={17} />
              {exporting ? 'Generando…' : 'Descargar Excel'}
            </Button>
          </div>
        </div>
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
      </Card>
      {error ? (
        <ErrorState message={error} retry={retry} />
      ) : loading || !data || !model || !current ? (
        <LoadingState />
      ) : view === 'journal' ? (
        <JournalWorkspace data={data.ledger} onChanged={refresh} />
      ) : view === 'credits' ? (
        <CreditWorkspace
          range={range}
          bankAccounts={data.ledger.accounts.filter(
            (a) => a.code.startsWith('1120-') && a.postable,
          )}
          onChanged={refresh}
        />
      ) : view === 'catalog' ? (
        <>
          <AccountEditor data={data.ledger} onSaved={refresh} />
          <AccountCatalog accounts={model.catalog} />
        </>
      ) : (
        <AccountingTables
          view={view}
          model={model}
          ledger={emptyLedger}
          onChanged={refresh}
          readOnly
        />
      )}
    </>
  )
}
