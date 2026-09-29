import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DocumentPrint } from '@/features/sales/DocumentPrint'
import { exampleDocument } from '@/features/sales/example'

it('la factura impresa lleva la política de cambios y devoluciones', () => {
  render(<DocumentPrint document={exampleDocument('invoice')} />)
  expect(
    screen.getByText(/Política de cambios y devoluciones/i).closest('p'),
  ).toHaveTextContent(
    'Por favor, revise su producto antes de retirarse de la tienda.',
  )
  expect(
    screen.getByText(/Política de cambios y devoluciones/i).closest('p'),
  ).toHaveTextContent(
    'La presentación de esta factura será necesaria para cualquier solicitud de revisión o cambio.',
  )
})

it('la proforma no lleva la política de cambios', () => {
  render(<DocumentPrint document={exampleDocument('proforma')} />)
  expect(
    screen.queryByText(/Política de cambios y devoluciones/i),
  ).not.toBeInTheDocument()
})
