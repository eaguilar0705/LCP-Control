/** Las secciones que dependen del período elegido. */
export const periodSections = {
  expenses: 'Gastos',
  movements: 'Caja y bancos',
  costs: 'Costos',
  daily: 'Cierre diario',
  statements: 'Estados financieros',
  ratios: 'Razones financieras',
} as const
export type PeriodSection = keyof typeof periodSections
