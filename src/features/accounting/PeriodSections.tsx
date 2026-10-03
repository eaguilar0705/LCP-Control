import { useCallback, useState } from 'react'
import { CalendarRange, FileSpreadsheet } from 'lucide-react'
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
  presetLabels,
  presetRange,
  type Preset,
  type ReportRange,
} from '../reports/model'
import { FinancialStatements } from './FinancialStatements'
import { FinanceMovements } from './FinanceMovements'
import { CostsTab, DailyCloseTab, ExpensesTab, RatiosTab } from './AnalysisTabs'
import type { PeriodSection } from './sections'
import { AccountingOverview } from './AccountingOverview'
import { CreditAccounts } from './CreditAccounts'
import { CashflowPanel } from './CashflowPanel'
import { CashCountPanel } from './CashCountPanel'

/**
 * Un solo período para todas las secciones: lo que se ve en gastos, caja,
 * costos, estados y razones sale de las mismas cifras.
 */
export function PeriodSections({
  section,
  onNavigate,
}: {
  section: PeriodSection
  onNavigate: (section: PeriodSection) => void
}) {
  const { reportService, financeService, salesService } = useServices()
  const [preset, setPreset] = useState<Preset | null>('30d')
  const [range, setRange] = useState<ReportRange>(() => presetRange('30d'))
  const [exporting, setExporting] = useState(false)
  const [failure, setFailure] = useState('')
  const load = useCallback(async () => {
    const [report, ledger, credits, cashflow] = await Promise.all([
      reportService.getSource(range),
      financeService.getLedger(range),
      section === 'credits'
        ? financeService.getCredits(range.to)
        : Promise.resolve(null),
      section === 'cashflow'
        ? financeService.getCashflow(range)
        : Promise.resolve(null),
    ])
    return { report, ledger, credits, cashflow }
  }, [reportService, financeService, range, section])
  const { data, loading, error, retry, refresh } = useQuery(load)
  const current =
    data?.report.range.from === range.from && data?.report.range.to === range.to

  async function exportExcel() {
    if (!data || !current || exporting) return
    const exportRange = { ...data.report.range }
    setExporting(true)
    setFailure('')
    try {
      const [{ accountingWorkbook }, business, credits, cashflow, closings] =
        await Promise.all([
          import('./accountingWorkbook'),
          salesService.getBusiness().catch(() => null),
          financeService.getCredits(exportRange.to),
          financeService.getCashflow(exportRange),
          financeService.getCashClosings(exportRange),
        ])
      accountingWorkbook(
        data.report,
        data.ledger.position,
        data.report.range,
        business?.name ?? 'La Casa del Perfume',
        { ledger: data.ledger, credits, cashflow, closings },
      )
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Card className="report-filters">
        <div className="preset-row" role="group" aria-label="Período">
          <CalendarRange size={17} />
          {(Object.keys(presetLabels) as Preset[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`preset ${preset === key ? 'preset-active' : ''}`}
              aria-pressed={preset === key}
              onClick={() => {
                setPreset(key)
                setRange(presetRange(key))
              }}
            >
              {presetLabels[key]}
            </button>
          ))}
        </div>
        <div className="filter-grid">
          <Input
            label="Desde"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => {
              if (!e.target.value) return
              setPreset(null)
              setRange((current) =>
                adjustRange(current, 'from', e.target.value),
              )
            }}
          />
          <Input
            label="Hasta"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => {
              if (!e.target.value) return
              setPreset(null)
              setRange((current) => adjustRange(current, 'to', e.target.value))
            }}
          />
          <div className="period-export">
            <Button
              variant="secondary"
              disabled={!data || !current || exporting}
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
      {(loading && !data) || (data && !current) ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <>
          {section === 'overview' && (
            <AccountingOverview
              report={data.report}
              ledger={data.ledger}
              onNavigate={onNavigate}
            />
          )}
          {section === 'credits' && data.credits && (
            <CreditAccounts ledger={data.credits} onChanged={refresh} />
          )}
          {section === 'cashflow' && data.cashflow && (
            <CashflowPanel ledger={data.cashflow} />
          )}
          {!data.ledger.available && (
            <p className="inline-error" role="alert">
              Falta aplicar la actualización de contabilidad en la base de
              datos.
            </p>
          )}
          {section === 'expenses' && (
            <ExpensesTab
              report={data.report}
              ledger={data.ledger}
              range={data.report.range}
              onChanged={refresh}
            />
          )}
          {section === 'movements' && (
            <FinanceMovements
              ledger={data.ledger}
              at={data.report.range.to}
              onChanged={refresh}
            />
          )}
          {section === 'costs' && (
            <CostsTab report={data.report} range={data.report.range} />
          )}
          {section === 'daily' && (
            <>
              <CashCountPanel
                key={`${data.report.range.from}:${data.report.range.to}`}
                range={data.report.range}
                onChanged={refresh}
              />
              <DailyCloseTab report={data.report} range={data.report.range} />
            </>
          )}
          {section === 'statements' && (
            <FinancialStatements
              report={data.report}
              position={data.ledger.position}
            />
          )}
          {section === 'ratios' && (
            <RatiosTab
              report={data.report}
              position={data.ledger.position}
              range={data.report.range}
            />
          )}
        </>
      )}
    </>
  )
}
