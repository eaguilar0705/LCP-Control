import type { DocumentRecord } from '../../lib/domain'

/**
 * Densidad de impresión de facturas y proformas. Las tres caben en una sola
 * hoja carta o A4 (se diseña para la intersección: 210 mm de ancho × 279,4 mm
 * de alto) hasta el número de renglones indicado:
 *
 * - `regular`  hasta 12 renglones: holgada, como el formato original.
 * - `compact`  hasta 25 renglones: menos relleno por fila.
 * - `dense`    hasta 40 renglones: interlineado mínimo, misma tipografía en
 *              negrita de 11 px (≈ 8,3 pt), legible en láser, tinta y térmica.
 *
 * Un renglón es un producto; los nombres largos que ocupan dos líneas cuentan
 * como dos. Por encima de 40 el documento sigue en otra hoja con el encabezado
 * de la tabla repetido.
 */
export type PrintDensity = 'regular' | 'compact' | 'dense'

export const PRINT_CAPACITY = { regular: 12, compact: 25, dense: 40 } as const

/** Caracteres que caben en una línea de la descripción en modo denso. */
const DESCRIPTION_CHARS = 72

export function printedLines(document: Pick<DocumentRecord, 'items'>) {
  return document.items.reduce(
    (sum, item) =>
      sum +
      Math.max(
        1,
        Math.ceil(item.description.trim().length / DESCRIPTION_CHARS),
      ),
    0,
  )
}

export function printDensity(
  document: Pick<DocumentRecord, 'items'>,
): PrintDensity {
  const lines = printedLines(document)
  return lines <= PRINT_CAPACITY.regular
    ? 'regular'
    : lines <= PRINT_CAPACITY.compact
      ? 'compact'
      : 'dense'
}
