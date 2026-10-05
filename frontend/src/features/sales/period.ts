import type { DocumentKind } from '../../lib/domain'
import { addDays, localDay, type ReportRange } from '../reports/model'

/**
 * Periodo del historial de facturas y proformas. Vive aparte del PDF (que
 * carga jsPDF) para que el servicio y la pantalla lo usen sin arrastrarlo.
 */

/**
 * Máximo de documentos por PDF. Cada uno ocupa al menos una hoja y el archivo
 * se arma en el navegador (medido: 1.000 facturas ≈ 2 s y 2,6 MB; 2.000 ≈ 4 s
 * y 5 MB). Por encima de este número se pide un rango más corto en lugar de
 * entregar un archivo recortado que parezca completo.
 */
export const DOCUMENT_EXPORT_LIMIT = 2000

/** Documentos por página en la lista del historial. */
export const HISTORY_PAGE_SIZE = 100

export type HistoryPreset = 'today' | '7d' | 'month' | 'lastMonth'
export const historyPresetLabels: Record<HistoryPreset, string> = {
  today: 'Hoy',
  '7d': 'Últimos 7 días',
  month: 'Este mes',
  lastMonth: 'Mes pasado',
}

/** Días de Managua (aaaa-mm-dd), ambos extremos incluidos. */
export function historyRange(
  preset: HistoryPreset,
  today = localDay(new Date()),
): ReportRange {
  const firstOfMonth = `${today.slice(0, 8)}01`
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: addDays(today, -6), to: today }
    case 'month':
      return { from: firstOfMonth, to: today }
    case 'lastMonth': {
      const lastDay = addDays(firstOfMonth, -1)
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay }
    }
  }
}

/**
 * Límites en UTC de un periodo en días de Managua. Managua no aplica horario
 * de verano: el día va de las 00:00 a las 24:00 en -06:00. Una factura de las
 * 11:30 p. m. es de ese día aunque en UTC ya sea el siguiente.
 */
export function managuaBounds(range: ReportRange) {
  return {
    from: new Date(`${range.from}T00:00:00-06:00`).toISOString(),
    until: new Date(`${addDays(range.to, 1)}T00:00:00-06:00`).toISOString(),
  }
}

export function periodFileName(kind: DocumentKind, range: ReportRange) {
  const name = kind === 'invoice' ? 'facturas' : 'proformas'
  return range.from === range.to
    ? `${name}-${range.from}.pdf`
    : `${name}-${range.from}-al-${range.to}.pdf`
}

const shortDate = new Intl.DateTimeFormat('es-NI', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
})
/** «01/09/2026» de un día aaaa-mm-dd, sin correrse por la zona horaria. */
export function shortDay(day: string) {
  return shortDate.format(new Date(`${day}T12:00:00Z`))
}

/** «del 01/09/2026 al 26/09/2026» o «del 26/09/2026». */
export function periodLabel(range: ReportRange) {
  return range.from === range.to
    ? `del ${shortDay(range.from)}`
    : `del ${shortDay(range.from)} al ${shortDay(range.to)}`
}
