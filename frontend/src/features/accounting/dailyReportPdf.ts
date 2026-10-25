import { jsPDF } from 'jspdf'
import { labels, type PaymentMethod } from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import { privateServices } from '../../services'
import type { BusinessDay } from './businessDay'

export async function downloadDailyReport(day: BusinessDay) {
  if (!day.report) return
  const business = await privateServices.salesService.getBusiness()
  const pdf = new jsPDF({ unit: 'mm', format: 'letter' })
  const r = day.report
  let y = 22
  const line = (label: string, value = '', bold = false) => {
    if (y > 250) {
      pdf.addPage()
      y = 22
    }
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(10.5)
    pdf.text(label, 18, y)
    if (value) pdf.text(value, 198, y, { align: 'right' })
    y += 7
  }
  pdf.setTextColor(88, 25, 30)
  line(business?.name ?? 'La Casa del Perfume', '', true)
  line('Reporte diario', day.day, true)
  if (day.status === 'closed') {
    line('Cierre', `Revisión ${day.revision ?? 1}`)
    if (day.closedAt)
      line(
        'Registrado',
        new Intl.DateTimeFormat('es-NI', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Managua',
        }).format(new Date(day.closedAt)),
      )
  }
  pdf.setTextColor(45, 40, 37)
  line(
    day.status === 'closed'
      ? 'Jornada cerrada'
      : 'Jornada abierta · corte provisional',
  )
  y += 4
  line('Facturas', String(r.invoices))
  line('Unidades vendidas', String(r.units))
  line(
    'Venta neta del día',
    r.netSalesNio == null ? 'Sin dato' : formatCurrency(r.netSalesNio, 'NIO'),
    true,
  )
  if ((r.returnsCount ?? 0) > 0) {
    line('Notas de crédito', String(r.returnsCount))
    line(
      'Unidades devueltas',
      r.returnedUnits == null ? 'Sin dato' : String(r.returnedUnits),
    )
    line(
      'Devoluciones',
      r.returnedNio == null ? 'Sin dato' : formatCurrency(r.returnedNio, 'NIO'),
    )
  }
  y += 4
  line('Ventas por forma de pago', '', true)
  for (const p of r.payments)
    line(
      labels.payment[p.method as PaymentMethod] ?? 'Crédito',
      formatCurrency(p.amount, p.currency),
    )
  y += 4
  line('Caja', '', true)
  for (const currency of ['NIO', 'USD'] as const) {
    const nio = currency === 'NIO'
    line(
      `Apertura ${currency}`,
      formatCurrency((nio ? day.openingNio : day.openingUsd) ?? 0, currency),
    )
    line(
      `Esperado ${currency}`,
      formatCurrency(nio ? r.expectedNio : r.expectedUsd, currency),
    )
    if (day.status === 'closed') {
      line(
        `Contado ${currency}`,
        formatCurrency((nio ? r.countedNio : r.countedUsd) ?? 0, currency),
      )
      line(
        `Diferencia ${currency}`,
        formatCurrency(
          (nio ? r.differenceNio : r.differenceUsd) ?? 0,
          currency,
        ),
        true,
      )
    }
  }
  if (r.note) {
    y += 4
    for (const text of pdf.splitTextToSize(r.note, 175) as string[]) line(text)
  }
  if (r.products.length) {
    y += 6
    line('Productos vendidos', 'Unidades', true)
    for (const product of r.products) {
      const nameLines = pdf.splitTextToSize(
        product.description,
        145,
      ) as string[]
      nameLines.forEach((name, index) =>
        line(name, index === 0 ? String(product.units) : ''),
      )
    }
  }
  pdf.save(
    `reporte-diario-${day.day}${day.status === 'closed' ? `-cierre-${day.revision ?? 1}` : ''}.pdf`,
  )
}
