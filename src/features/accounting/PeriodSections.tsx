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

/**
 * Un solo período para todas las secciones: lo que se ve en gastos, caja,
 * costos, estados y razones sale de las mismas cifras.
 */
export function PeriodSections({ section }: { section: PeriodSection }) {
  const { reportService, financeService, salesService } = useServices()
  const [preset, setPreset] = useState<Preset | null>('30d')
  const [range, setRange] = useState<ReportRange>(() => presetRange('30d'))
  const [exporting, setExporting] = useState(false)
  const [failure, setFailure] = useState('')
  const load = useCallback(async () => {
    const [report, ledger] = await Promise.all([
      reportService.getSource(range),
      financeService.getLedger(range),
    ])
    return { report, ledger }
  }, [reportService, financeService, range])
  const { data, loading, error, retry, refresh } = useQuery(load)

  async function exportExcel() {
    if (!data) return
    setExporting(true)
    setFailure('')
    try {
      const [{ accountingWorkbook }, business] = await Promise.all([
        import('./accountingWorkbook'),
        salesService.getBusiness().catch(() => null),
      ])
      accountingWorkbook(
        data.report,
        data.ledger.position,
        data.report.range,
        business?.name ?? 'La Casa del Perfume',
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
              disabled={!data || exporting}
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
      {loading && !data ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <>
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
            <DailyCloseTab report={data.report} range={data.report.range} />
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
