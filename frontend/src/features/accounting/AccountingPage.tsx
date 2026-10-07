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
import {
  adjustRange,
  addDays,
  localDay,
  type ReportRange,
} from '../reports/model'
import { accountingViews, buildAccountingModel } from './accountingModel'
import { AccountingTables, AccountCatalog } from './AccountingTables'
import '../../styles/accounting.css'

type View = keyof typeof accountingViews

export function AccountingPage() {
  const { reportService, financeService, salesService } = useServices()
  const [view, setView] = useState<View>('catalog')
  const [range, setRange] = useState<ReportRange>(() => {
    const today = localDay(new Date())
    return { from: `${today.slice(0, 7)}-01`, to: today }
  })
  const [exporting, setExporting] = useState(false)
  const [failure, setFailure] = useState('')
  const load = useCallback(async () => {
    const before = addDays(range.from, -1)
    const [report, ledger, openingLedger, business] = await Promise.all([
      reportService.getSource(range),
      financeService.getLedger(range),
      financeService.getLedger({ from: before, to: before }),
      salesService.getBusiness(),
    ])
    const start = ledger.position.startOn ?? `${range.to.slice(0, 4)}-01-01`
    const accumulatedFrom = start < range.from ? start : range.from
    const [cumulativeReport, openingReport] = await Promise.all([
      accumulatedFrom === range.from
        ? Promise.resolve(report)
        : reportService.getSource({ from: accumulatedFrom, to: range.to }),
      accumulatedFrom < range.from
        ? reportService.getSource({ from: accumulatedFrom, to: before })
        : Promise.resolve(null),
    ])
    return {
      report,
      ledger,
      openingLedger,
      cumulativeReport,
      openingReport,
      accumulatedFrom,
      businessName: business?.name ?? 'La Casa del Perfume',
    }
  }, [reportService, financeService, salesService, range])
  const { data, loading, error, retry, refresh } = useQuery(load)
  const current =
    data?.report.range.from === range.from && data?.report.range.to === range.to
  const model = useMemo(
    () => (data ? buildAccountingModel(data) : null),
    [data],
  )

  async function exportExcel() {
    if (!model || !current || exporting) return
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
        <div>
          <h1>Contabilidad</h1>
          <p>Cuentas y estados contables de la perfumería.</p>
        </div>
      </div>
      <nav
        className="accounting-tabs accounting-tabs-standalone"
        aria-label="Secciones de contabilidad"
      >
        {(Object.keys(accountingViews) as View[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {accountingViews[id]}
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
            onChange={(event) => {
              if (event.target.value)
                setRange((previous) =>
                  adjustRange(previous, 'from', event.target.value),
                )
            }}
          />
          <Input
            label="Hasta"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(event) => {
              if (event.target.value)
                setRange((previous) =>
                  adjustRange(previous, 'to', event.target.value),
                )
            }}
          />
          <div className="period-export">
            <Button
              variant="secondary"
              disabled={!model || !current || exporting}
              onClick={() => void exportExcel()}
            >
              <FileSpreadsheet size={17} />
              {exporting ? 'Generando…' : 'Descargar Excel'}
            </Button>
          </div>
        </div>
        {failure && (
          <p className="inline-error" role="alert">
            {failure}
          </p>
        )}
      </Card>
      {view === 'catalog' ? (
        <>
          {error && <ErrorState message={error} retry={retry} />}
          <AccountCatalog
            accounts={model && current ? model.catalog : undefined}
          />
        </>
      ) : (loading && !data) || (data && !current) ? (
        <LoadingState />
      ) : error || !model || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <AccountingTables
          view={view}
          model={model}
          ledger={data.ledger}
          onChanged={refresh}
        />
      )}
    </>
  )
}
