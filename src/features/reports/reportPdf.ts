import { jsPDF } from 'jspdf'
import { formatCurrency, formatDate } from '../../lib/format'
import { accountingByMonth, accountingSummary, belowCostSummary, expenseAccounts, inventoryTurnover } from './accounting'
import { priceTierLabels } from '../../lib/pricing'
import { reportTables, type ReportContext } from './export'

/**
 * Resumen ejecutivo en carta, con la misma identidad que las facturas. El
 * detalle completo vive en el libro de Excel: aquí van las cifras que se leen
 * de un vistazo y se imprimen para una reunión.
 */

const WINE: [number, number, number] = [87, 23, 28]
const INK: [number, number, number] = [40, 34, 31]
const GRAY: [number, number, number] = [110, 103, 99]

let logoPromise: Promise<Uint8Array | null> | null = null
function loadLogo() {
  logoPromise ??= fetch('/brand/wordmark-wine.jpeg')
    .then(async (response) =>
      response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
    )
    // El reporte se entrega igual sin logotipo: no es motivo para fallar.
    .catch(() => null)
  return logoPromise
}

export async function renderReportPdf(context: ReportContext): Promise<Blob> {
  const { range, tier, business } = context
  const tables = reportTables(context)
  const pdf = new jsPDF({ unit: 'pt', format: 'letter', compress: true })
  const left = 40
  const right = 572
  const width = right - left
  let y = 0
  const logo = await loadLogo()

  function text(
    value: string,
    x: number,
    at: number,
    size = 9,
    bold = false,
    align: 'left' | 'right' = 'left',
    color = INK,
  ) {
    pdf
      .setFont('helvetica', bold ? 'bold' : 'normal')
      .setFontSize(size)
      .setTextColor(...color)
    pdf.text(value, x, at, { align })
  }
  function space(needed: number) {
    if (y + needed > 730) {
      pdf.addPage()
      y = 56
    }
  }
  function heading(title: string) {
    space(40)
    y += 16
    pdf.setFillColor(...WINE).rect(left, y - 9, 3, 11, 'F')
    text(title, left + 9, y, 11, true)
    y += 12
  }
  /** Dibuja una tabla y devuelve la altura usada. Nunca corta una fila. */
  function table(
    columns: { label: string; width: number; align?: 'right' }[],
    rows: string[][],
  ) {
    const positions: number[] = []
    let cursor = left
    for (const column of columns) {
      positions.push(column.align === 'right' ? cursor + column.width : cursor)
      cursor += column.width
    }
    space(28)
    y += 14
    pdf.setFillColor(245, 241, 236).rect(left, y - 10, width, 16, 'F')
    columns.forEach((column, index) =>
      text(
        column.label,
        positions[index],
        y,
        7.5,
        true,
        column.align ?? 'left',
        GRAY,
      ),
    )
    y += 8
    for (const row of rows) {
      space(18)
      y += 13
      row.forEach((value, index) =>
        text(
          value,
          positions[index],
          y,
          8.5,
          false,
          columns[index].align ?? 'left',
        ),
      )
      pdf.setDrawColor(232, 226, 219).setLineWidth(0.5)
      pdf.line(left, y + 4, right, y + 4)
    }
    y += 8
  }

  // Encabezado
  if (logo) pdf.addImage(logo, 'JPEG', left, 34, 150, 68.3)
  else text(business.name, left, 68, 16, true, 'left', WINE)
  text('REPORTE DEL NEGOCIO', right, 52, 9, true, 'right', WINE)
  text(
    `${formatDate(range.from)} — ${formatDate(range.to)}`,
    right,
    68,
    11,
    true,
    'right',
  )
  text(
    `Emitido el ${formatDate(new Date())}`,
    right,
    82,
    8,
    false,
    'right',
    GRAY,
  )
  y = 112
  pdf.setFillColor(...WINE).rect(left, y, width, 2.5, 'F')
  y += 10

  heading('Contabilidad · costo promedio ponderado · NIO')
  const accounting = accountingSummary(context.report, range)
  const turnover = inventoryTurnover(accounting, range)
  const losses = belowCostSummary(context.report, range)
  const nio = (amount: number | null) => amount === null ? 'Sin determinar' : formatCurrency(amount, 'NIO')
  if (!context.report.accounting.available) {
    text('Sin fuente contable disponible. Los precios de venta no son costos de compra.', left, (y += 14), 9)
  } else {
    if (!accounting.complete) {
      text('RESULTADO INCOMPLETO: faltan costos, datos históricos o filas del periodo.', left, (y += 14), 9, true)
    }
    table([{ label: 'ESTADO DE RESULTADOS', width: 362 }, { label: 'IMPORTE NIO', width: 170, align: 'right' }], [
      ['Ventas sin impuesto (parte documentada)', nio(accounting.revenueNio)],
      ['Costo de ventas conocido', nio(accounting.costOfSalesNio)],
      ['Utilidad bruta', nio(accounting.grossProfitNio)],
      ['Gastos reconocidos (los que restan)', nio(accounting.expensesNio)],
      ['Mermas y salidas a costo conocido', nio(accounting.inventoryWriteOffNio)],
      ['Resultado operativo registrado', nio(accounting.netProfitNio)],
    ])
    heading('Pedidos de importación e inventario')
    table([{ label: 'CONCEPTO', width: 362 }, { label: 'IMPORTE NIO', width: 170, align: 'right' }], [
      ['Precio de los perfumes pedidos', nio(accounting.purchaseGoodsNio)],
      ['Envío cobrado por la agencia (peso)', nio(accounting.purchaseShippingNio)],
      ['Total invertido en pedidos', `${nio(accounting.purchasesNio)} · ${accounting.purchasedUnits} uds.`],
      ['Impuesto incluido en ventas documentadas', nio(accounting.salesTaxNio)],
      ['Inventario actual a costo conocido', nio(accounting.inventoryCostNio)],
      ['Rotación anual del inventario', turnover.turnoverPerYear === null ? 'Sin determinar' : `${turnover.turnoverPerYear} veces`],
      ['Días que dura el inventario', turnover.daysOnHand === null ? 'Sin determinar' : `${turnover.daysOnHand} días`],
    ])
    heading('Gastos por cuenta')
    table([{ label: 'CUENTA', width: 362 }, { label: 'IMPORTE NIO', width: 170, align: 'right' }],
      accounting.expenseByAccount.map((row) => [
        expenseAccounts[row.account].label + (row.deducts ? '' : ' — no resta del resultado'),
        nio(row.amountNio),
      ]))
    text('El pago de préstamos devuelve capital: lo que cuesta el préstamo son sus intereses. Los gastos operativos son los pedidos del periodo y pesan en el resultado al vender la mercadería.', left, (y += 14), 8)
    text(`${accounting.missingCostUnits} unidades vendidas sin costo; ${accounting.unvaluedProducts} productos sin valoración de inventario.`, left, (y += 14), 8)
    text('Inventario actual. Costo puesto = precio del proveedor + envío por unidad. Los pedidos se descuentan al vender.', left, (y += 13), 8)
    heading('Evolución del resultado operativo')
    table([
      { label: 'MES', width: 65 }, { label: 'VENTA NETA*', width: 112, align: 'right' },
      { label: 'COSTO VENTAS*', width: 112, align: 'right' }, { label: 'GASTOS + SALIDAS*', width: 125, align: 'right' },
      { label: 'RESULTADO', width: 118, align: 'right' },
    ], accountingByMonth(context.report, range).map(({ month, totals }) => [month, nio(totals.revenueNio), nio(totals.costOfSalesNio), nio(totals.expensesNio + totals.inventoryWriteOffNio), nio(totals.netProfitNio)]))
    text('* Parte documentada. Las cifras parciales no determinan una utilidad total.', left, (y += 13), 8)
    if (accounting.products.length) {
      heading('Rentabilidad por producto')
      table([
        { label: 'PRODUCTO', width: 220 }, { label: 'VENTA NETA*', width: 104, align: 'right' },
        { label: 'COSTO*', width: 100, align: 'right' }, { label: 'UTILIDAD', width: 108, align: 'right' },
      ], accounting.products.slice(0, 15).map((row) => [row.description.slice(0, 42), nio(row.netRevenueNio), nio(row.costNio), nio(row.profitNio)]))
    }
    if (accounting.tiers.length) {
      heading('Rentabilidad por lista de precios')
      table([
        { label: 'LISTA', width: 220 }, { label: 'VENTA NETA*', width: 104, align: 'right' },
        { label: 'COSTO*', width: 100, align: 'right' }, { label: 'UTILIDAD', width: 108, align: 'right' },
      ], accounting.tiers.map((row) => [priceTierLabels[row.tier], nio(row.netRevenueNio), nio(row.costNio), nio(row.profitNio)]))
    }
    if (losses.count) {
      heading('Ventas por debajo del costo')
      table([
        { label: 'DOCUMENTO', width: 96 }, { label: 'PRODUCTO', width: 190 },
        { label: 'VENTA NETA', width: 118, align: 'right' }, { label: 'PÉRDIDA', width: 128, align: 'right' },
      ], losses.rows.slice(0, 15).map((row) => [row.number, row.description.slice(0, 36), nio(row.netRevenueNio), nio(row.lossNio)]))
      text(`${losses.count} renglón(es) se facturaron bajo su propio costo registrado (${nio(losses.lossNio)} de pérdida).`, left, (y += 13), 8)
    }
  }

  if (!tables.currencies.length) {
    heading('Sin ventas en el periodo')
    y += 6
    text(
      'No se emitieron facturas en el rango seleccionado.',
      left,
      y,
      9,
      false,
      'left',
      GRAY,
    )
  }

  for (const block of tables.perCurrency) {
    heading(block.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (US$)')
    table(
      [
        // Los rótulos se alinean a la derecha, así que cada uno necesita caber
        // en su propia columna o invade la anterior.
        { label: 'INGRESOS', width: 118 },
        { label: 'FACTURAS', width: 68, align: 'right' },
        { label: 'TICKET PROMEDIO', width: 112, align: 'right' },
        { label: 'UNIDADES', width: 76, align: 'right' },
        { label: 'CLIENTES', width: 68, align: 'right' },
        { label: 'VARIACIÓN', width: 90, align: 'right' },
      ],
      [
        [
          block.money(block.totals.revenue),
          String(block.totals.count),
          block.money(block.totals.average),
          String(block.totals.units),
          String(block.totals.customers),
          block.variation === null
            ? 'sin base'
            : `${block.variation >= 0 ? '+' : '-'}${Math.abs(Math.round(block.variation * 100))} %`,
        ],
      ],
    )
    text(
      `Periodo anterior: ${block.money(block.before.revenue)} en ${block.before.count} facturas.`,
      left,
      (y += 14),
      8,
      false,
      'left',
      GRAY,
    )
    if (block.products.length) {
      heading('Productos más vendidos')
      table(
        [
          { label: 'PRODUCTO', width: 300 },
          { label: 'UNIDADES', width: 100, align: 'right' },
          { label: 'IMPORTE', width: 132, align: 'right' },
        ],
        block.products.map((product) => [
          product.description.slice(0, 62),
          String(product.quantity),
          block.money(product.revenue),
        ]),
      )
    }
    if (block.clients.top.length) {
      heading(
        `Clientes · ${block.clients.newCustomers} nuevos, ${block.clients.returning} recurrentes`,
      )
      table(
        [
          { label: 'CLIENTE', width: 300 },
          { label: 'FACTURAS', width: 100, align: 'right' },
          { label: 'IMPORTE', width: 132, align: 'right' },
        ],
        block.clients.top.map((client) => [
          client.name.slice(0, 52),
          String(client.count),
          block.money(client.revenue),
        ]),
      )
    }
    if (block.payments.length) {
      heading('Formas de pago y listas de precios')
      table(
        [
          { label: 'CONCEPTO', width: 300 },
          { label: 'FACTURAS', width: 100, align: 'right' },
          { label: 'IMPORTE', width: 132, align: 'right' },
        ],
        [
          ...block.payments.map((share) => [
            share.label,
            String(share.count),
            block.money(share.value),
          ]),
          ...block.tiers.map((share) => [
            `Lista ${share.label}`,
            String(share.count),
            block.money(share.value),
          ]),
        ],
      )
    }
    if (block.lapsed.length) {
      heading('Clientes que no volvieron')
      table(
        [
          { label: 'CLIENTE', width: 250 },
          { label: 'ÚLTIMA COMPRA', width: 130, align: 'right' },
          { label: 'DEJÓ DE FACTURAR', width: 152, align: 'right' },
        ],
        block.lapsed.map((client) => [
          client.name.slice(0, 46),
          `hace ${client.daysSince} días`,
          block.money(client.previousRevenue),
        ]),
      )
    }
    heading('Ventas por día de la semana')
    table(
      [
        { label: 'DÍA', width: 200 },
        { label: 'FACTURAS', width: 150, align: 'right' },
        { label: 'INGRESOS', width: 182, align: 'right' },
      ],
      block.weekdays
        .filter((day) => day.count > 0)
        .map((day) => [day.label, String(day.count), block.money(day.revenue)]),
    )
    const notes: string[] = []
    if (block.productShare !== null)
      notes.push(
        `Los diez productos principales concentran el ${Math.round(block.productShare * 100)} % de los ingresos.`,
      )
    if (block.proformas)
      notes.push(
        block.conversion.rate === null
          ? `Proformas emitidas: ${block.proformas}.`
          : `Proformas: ${block.proformas}, de las que ${block.conversion.converted} terminaron en factura (${Math.round(block.conversion.rate * 100)} %, estimado por cliente y fecha).`,
      )
    for (const note of notes)
      text(note, left, (y += 13), 8, false, 'left', GRAY)
  }

  if (tables.coverage.length) {
    heading('Qué reponer primero')
    table(
      [
        { label: 'PRODUCTO', width: 250 },
        { label: 'EXISTENCIAS', width: 110, align: 'right' },
        { label: 'VENTA DIARIA', width: 100, align: 'right' },
        { label: 'DÍAS DE COBERTURA', width: 72, align: 'right' },
      ],
      tables.coverage.map((row) => [
        row.description.slice(0, 46),
        String(row.stock),
        row.perDay.toFixed(2),
        Number.isFinite(row.days) ? row.days.toFixed(1) : '—',
      ]),
    )
  }
  if (tables.idle.length) {
    heading('Capital detenido')
    table(
      [
        { label: 'PRODUCTO SIN VENTAS', width: 300 },
        { label: 'EXISTENCIAS', width: 100, align: 'right' },
        { label: 'VALOR A LISTA', width: 132, align: 'right' },
      ],
      tables.idle.map((row) => [
        row.description.slice(0, 52),
        String(row.stock),
        tables.money(row.listValue),
      ]),
    )
  }
  if (tables.damaged.length) {
    heading('Mermas')
    table(
      [
        { label: 'PRODUCTO', width: 300 },
        { label: 'UNIDADES DAÑADAS', width: 100, align: 'right' },
        { label: 'VALOR A LISTA', width: 132, align: 'right' },
      ],
      tables.damaged.map((row) => [
        row.description.slice(0, 52),
        String(row.units),
        tables.money(row.listValue),
      ]),
    )
  }

  heading('Inventario y movimientos')
  table(
    [
      { label: 'CON EXISTENCIAS', width: 110 },
      { label: 'BAJO EL MÍNIMO', width: 110, align: 'right' },
      { label: 'AGOTADOS', width: 100, align: 'right' },
      { label: 'SIN CONTEO', width: 100, align: 'right' },
      { label: 'UNIDADES', width: 112, align: 'right' },
    ],
    [
      [
        String(tables.health.available),
        String(tables.health.low),
        String(tables.health.out),
        String(tables.health.uncounted),
        String(tables.health.units),
      ],
    ],
  )
  table(
    [
      { label: 'ENTRADAS', width: 110 },
      { label: 'VENTAS', width: 110, align: 'right' },
      { label: 'SALIDAS', width: 100, align: 'right' },
      { label: 'DAÑADOS', width: 100, align: 'right' },
      { label: 'AJUSTES', width: 112, align: 'right' },
    ],
    [
      [
        String(tables.movements.entries),
        String(tables.movements.sales),
        String(tables.movements.exits),
        String(tables.movements.damaged),
        String(tables.movements.adjustments),
      ],
    ],
  )

  space(60)
  y += 22
  pdf.setDrawColor(...WINE).setLineWidth(1)
  pdf.line(left, y, right, y)
  y += 14
  text(
    `Inventario valorado con la lista ${priceTierLabels[tier]}: es precio de venta, no costo de compra.`,
    left,
    y,
    7.5,
    false,
    'left',
    GRAY,
  )
  y += 11
  text(
    'Ventas por moneda original; contabilidad en NIO con tasas guardadas. Documento interno, no es un comprobante fiscal.',
    left,
    y,
    7.5,
    false,
    'left',
    GRAY,
  )

  const pages = pdf.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page)
    text(
      `${business.name} · página ${page} de ${pages}`,
      right,
      756,
      7.5,
      false,
      'right',
      GRAY,
    )
  }
  return pdf.output('blob')
}
