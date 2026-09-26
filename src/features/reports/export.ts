import type { BusinessSettings, Currency, PriceTier } from '../../lib/domain'
import { formatCurrency, formatDate } from '../../lib/format'
import { priceTierLabels } from '../../lib/pricing'
import { buildWorkbook, type Sheet } from '../../lib/xlsx'
import { totalStock } from '../inventory/model'
import { accountingSheets } from './accountingExport'
import { fillDays, type ReportRange } from './model'
import { DIGEST_LIST_LIMIT, reportView, type ReportData } from './digest'

export interface ReportContext {
  report: ReportData
  range: ReportRange
  tier: PriceTier
  business: BusinessSettings
}

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')
function fileName(range: ReportRange, extension: string) {
  return `reporte-${range.from}-a-${range.to}`
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .concat(extension)
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function exportReport(
  format: 'pdf' | 'excel',
  context: ReportContext,
) {
  if (format === 'excel') {
    download(buildReportWorkbook(context), fileName(context.range, '.xlsx'))
    return
  }
  const { renderReportPdf } = await import('./reportPdf')
  download(await renderReportPdf(context), fileName(context.range, '.pdf'))
}

/**
 * El libro lleva el detalle completo, una hoja por tema, para que el contador o
 * el dueño puedan filtrar y sumar por su cuenta. Las cifras van como números;
 * el formato se aplica en la columna.
 */
export function buildReportWorkbook({
  report,
  range,
  tier,
  business,
}: ReportContext): Blob {
  const view = reportView(report)
  const currencies = view.currencies
  const header = [
    business.name,
    `Reporte del ${formatDate(range.from)} al ${formatDate(range.to)}`,
    'Ventas comerciales por moneda original; contabilidad en NIO con la tasa guardada por operación.',
  ]
  const sheets: Sheet[] = accountingSheets(report, range, business.name)

  sheets.push({
    name: 'Resumen',
    notes: [
      ...header,
      report.truncated
        ? 'Aviso: el periodo superó las filas consultadas; acorta el rango para un total exacto.'
        : '',
    ].filter(Boolean),
    columns: [
      { header: 'Moneda', width: 12 },
      { header: 'Ingresos', format: 'money', width: 16 },
      { header: 'Facturas', format: 'integer', width: 11 },
      { header: 'Ticket promedio', format: 'money', width: 17 },
      { header: 'Unidades', format: 'integer', width: 11 },
      { header: 'Clientes', format: 'integer', width: 11 },
      { header: 'Proformas', format: 'integer', width: 11 },
      { header: 'Ingresos periodo anterior', format: 'money', width: 22 },
      { header: 'Variación', format: 'number', width: 12 },
    ],
    rows: currencies.map((currency) => {
      const totals = view.summary(currency)
      const before = view.previousSummary(currency)
      const variation = view.variation(currency)
      return [
        currency,
        totals.revenue,
        totals.count,
        Number(totals.average.toFixed(2)),
        totals.units,
        totals.customers,
        view.proformaCount(currency),
        before.revenue,
        variation === null ? null : Number((variation * 100).toFixed(1)),
      ]
    }),
  })

  sheets.push({
    name: 'Ingresos por día',
    notes: header,
    columns: [
      { header: 'Día', width: 14 },
      ...currencies.flatMap((currency) => [
        { header: `Ingresos ${currency}`, format: 'money' as const, width: 16 },
        {
          header: `Facturas ${currency}`,
          format: 'integer' as const,
          width: 15,
        },
      ]),
    ],
    rows: (() => {
      const series = currencies.map((currency) => view.revenueByDay(currency))
      const days = series[0] ?? fillDays([], range)
      return days.map((point, index) => [
        point.day,
        ...series.flatMap((entries) => [
          entries[index]?.revenue ?? 0,
          entries[index]?.count ?? 0,
        ]),
      ])
    })(),
  })

  for (const currency of currencies) {
    sheets.push({
      name: `Productos ${currency}`,
      notes: header,
      columns: [
        { header: 'Producto', width: 46 },
        { header: 'Unidades', format: 'integer', width: 12 },
        { header: 'Importe', format: 'money', width: 16 },
      ],
      rows: view.topProducts(currency, DIGEST_LIST_LIMIT).map((product) => [
        product.description,
        product.quantity,
        product.revenue,
      ]),
    })
    const clients = view.customerActivity(currency, DIGEST_LIST_LIMIT)
    sheets.push({
      name: `Clientes ${currency}`,
      notes: [
        ...header,
        `Nuevos en el periodo: ${clients.newCustomers} · Ya eran clientes: ${clients.returning}`,
      ],
      columns: [
        { header: 'Cliente', width: 36 },
        { header: 'Facturas', format: 'integer', width: 12 },
        { header: 'Importe', format: 'money', width: 16 },
      ],
      rows: clients.top.map((client) => [
        client.name,
        client.count,
        client.revenue,
      ]),
    })
    sheets.push({
      name: `Seguimiento ${currency}`,
      notes: [
        ...header,
        'Clientes que compraron en el periodo anterior y no en éste, y cada cuánto vuelve cada uno.',
      ],
      columns: [
        { header: 'Cliente', width: 34 },
        { header: 'Situación', width: 22 },
        { header: 'Última compra', width: 16 },
        { header: 'Días desde entonces', format: 'integer', width: 20 },
        { header: 'Compras', format: 'integer', width: 11 },
        { header: 'Importe anterior', format: 'money', width: 18 },
      ],
      rows: [
        ...view.lapsedCustomers(currency, DIGEST_LIST_LIMIT).map(
          (client) => [
            client.name,
            'No volvió',
            client.lastPurchase,
            client.daysSince,
            client.orders,
            client.previousRevenue,
          ],
        ),
        ...view.purchaseFrequency(currency, range.to, DIGEST_LIST_LIMIT).map(
          (client) => [
            client.name,
            client.averageDays === null
              ? 'Una sola compra'
              : `Vuelve cada ${client.averageDays.toFixed(1)} días`,
            '',
            client.daysSinceLast,
            client.orders,
            null,
          ],
        ),
      ],
    })
    sheets.push({
      name: `Semana ${currency}`,
      notes: [
        ...header,
        (() => {
          const conversion = view.proformaConversion(currency)
          return conversion.rate === null
            ? 'Sin proformas en el periodo.'
            : `Proformas: ${conversion.proformas} · terminaron en factura: ${conversion.converted} (${Math.round(conversion.rate * 100)} %, estimado por cliente y fecha).`
        })(),
        (() => {
          const share = view.productShare(currency)
          return share === null
            ? ''
            : `Los diez productos principales concentran el ${Math.round(share * 100)} % de los ingresos.`
        })(),
      ].filter(Boolean),
      columns: [
        { header: 'Día de la semana', width: 20 },
        { header: 'Ingresos', format: 'money', width: 16 },
        { header: 'Facturas', format: 'integer', width: 12 },
      ],
      rows: view.salesByWeekday(currency).map((day) => [
        day.label,
        day.revenue,
        day.count,
      ]),
    })
    sheets.push({
      name: `Cobros ${currency}`,
      notes: header,
      columns: [
        { header: 'Concepto', width: 26 },
        { header: 'Facturas', format: 'integer', width: 12 },
        { header: 'Importe', format: 'money', width: 16 },
      ],
      rows: [
        ...view.paymentBreakdown(currency).map((share) => [
          `Forma de pago: ${share.label}`,
          share.count,
          share.value,
        ]),
        ...view.tierBreakdown(currency).map((share) => [
          `Lista: ${share.label}`,
          share.count,
          share.value,
        ]),
      ],
    })
  }

  // Las facturas del periodo ya no van en el libro: se exportan en PDF desde
  // el historial de facturas, con el listado y cada documento completo.
  const health = view.inventoryHealth(tier, view.first)
  const movements = view.movementSummary()
  sheets.push({
    name: 'Inventario',
    notes: [
      ...header,
      `Valorado con la lista ${priceTierLabels[tier]}. Es precio de venta, no costo de compra.`,
      `Con existencias ${health.available} · Bajo el mínimo ${health.low} · Agotados ${health.out} · Sin conteo ${health.uncounted}`,
      `Movimientos: entradas ${movements.entries} · ventas ${movements.sales} · salidas ${movements.exits} · dañados ${movements.damaged} · ajustes ${movements.adjustments}`,
    ],
    columns: [
      { header: 'Código', width: 16 },
      { header: 'Producto', width: 34 },
      { header: 'Marca', width: 20 },
      { header: 'Bodega', format: 'integer', width: 10 },
      { header: 'Tienda', format: 'integer', width: 10 },
      { header: 'Total', format: 'integer', width: 10 },
      { header: 'Mínimo', format: 'integer', width: 10 },
      { header: 'Precio lista', format: 'money', width: 14 },
    ],
    rows: report.inventory.map((item) => [
      item.product.barcode,
      item.product.name,
      item.product.brand,
      item.quantities.warehouse,
      item.quantities.store,
      totalStock(item),
      item.product.minimumStock,
      item.product.prices?.[tier][currencies[0] ?? 'NIO'] ?? null,
    ]),
  })

  const first = view.first
  sheets.push({
    name: 'Reposición',
    notes: [
      ...header,
      'Días de cobertura al ritmo de venta del periodo, y existencias que no se movieron.',
    ],
    columns: [
      { header: 'Producto', width: 42 },
      { header: 'Situación', width: 20 },
      { header: 'Existencias', format: 'integer', width: 13 },
      { header: 'Venta diaria', format: 'number', width: 14 },
      { header: 'Días de cobertura', format: 'number', width: 18 },
      { header: 'Valor a lista', format: 'money', width: 16 },
    ],
    rows: [
      ...view.stockCoverage(first, 500).map(
        (row) => [
          row.description,
          'Se vende',
          row.stock,
          Number(row.perDay.toFixed(2)),
          Number.isFinite(row.days) ? Number(row.days.toFixed(1)) : null,
          null,
        ],
      ),
      ...view.idleStock(tier, first, 500).map((row) => [
        row.description,
        'Sin ventas en el periodo',
        row.stock,
        0,
        null,
        row.listValue,
      ]),
    ],
  })

  const damaged = view.shrinkage(tier, first, 500)
  if (damaged.length)
    sheets.push({
      name: 'Mermas',
      notes: [...header, 'Unidades dañadas registradas en el periodo.'],
      columns: [
        { header: 'Producto', width: 42 },
        { header: 'Unidades', format: 'integer', width: 12 },
        { header: 'Valor a lista', format: 'money', width: 16 },
      ],
      rows: damaged.map((row) => [row.description, row.units, row.listValue]),
    })

  return buildWorkbook(sheets)
}

/** Las cifras que van al PDF, ya resueltas: el diseño sólo las coloca. */
export function reportTables({ report, tier }: ReportContext) {
  const view = reportView(report)
  const { currencies, first } = view
  return {
    currencies,
    perCurrency: currencies.map((currency: Currency) => ({
      currency,
      totals: view.summary(currency),
      before: view.previousSummary(currency),
      variation: view.variation(currency),
      proformas: view.proformaCount(currency),
      conversion: view.proformaConversion(currency),
      products: view.topProducts(currency, 10),
      payments: view.paymentBreakdown(currency),
      tiers: view.tierBreakdown(currency),
      clients: view.customerActivity(currency),
      lapsed: view.lapsedCustomers(currency, 6),
      weekdays: view.salesByWeekday(currency),
      productShare: view.productShare(currency),
      money: (value: number) => formatCurrency(value, currency),
    })),
    coverage: view.stockCoverage(first, 8),
    idle: view.idleStock(tier, first, 6),
    damaged: view.shrinkage(tier, first, 6),
    health: view.inventoryHealth(tier, first),
    movements: view.movementSummary(),
    /** Moneda de referencia para las cifras que no van por moneda. */
    money: (value: number) => formatCurrency(value, first),
  }
}
