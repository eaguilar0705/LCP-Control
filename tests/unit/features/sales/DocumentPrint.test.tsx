import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DocumentPrint } from '@/features/sales/DocumentPrint'
import { exampleDocument } from '@/features/sales/example'

it('la factura impresa lleva la política de cambios y devoluciones', () => {
  render(<DocumentPrint document={exampleDocument('invoice')} />)
  expect(
    screen.getByText(/Política de cambios y devoluciones/i).closest('p'),
  ).toHaveTextContent(
    'No se hacen devoluciones de dinero. Se aceptan cambios dentro de los 7 días posteriores a la compra',
  )
})

it('la proforma no lleva la política de cambios', () => {
  render(<DocumentPrint document={exampleDocument('proforma')} />)
  expect(
    screen.queryByText(/Política de cambios y devoluciones/i),
  ).not.toBeInTheDocument()
})
