/** Las secciones que dependen del período elegido. */
export const periodSections = {
  overview: 'Resumen',
  expenses: 'Gastos',
  movements: 'Caja y bancos',
  credits: 'Cobros y pagos',
  cashflow: 'Flujo de efectivo',
  costs: 'Costos',
  daily: 'Cierre diario',
  statements: 'Estados financieros',
  ratios: 'Razones financieras',
} as const
export type PeriodSection = keyof typeof periodSections
