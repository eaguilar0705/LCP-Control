import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductSelect } from '@/components/ProductSelect'
import type { Product } from '@/lib/domain'

const products = [
  {
    id: 'one',
    name: 'Ámbar',
    brand: 'Marca A',
    barcode: 'LCP-0001',
    manufacturerBarcode: '012345678905',
    size: 100,
    unit: 'ml',
  },
  {
    id: 'two',
    name: 'Cedro',
    brand: 'Marca B',
    barcode: 'LCP-0002',
    size: 50,
    unit: 'ml',
  },
] as Product[]
function Form({
  onSubmit = vi.fn(),
  disabled = false,
}: {
  onSubmit?: () => void
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <fieldset disabled={disabled}>
        <ProductSelect
          label="Perfume"
          products={products}
          value={value}
          onChange={setValue}
        />
      </fieldset>
      <button>Guardar</button>
      <output>{value}</output>
    </form>
  )
}
it('filters names without accents, preserves barcode zeros and chooses by keyboard', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(<Form onSubmit={submit} />)
  await user.click(screen.getByRole('button', { name: /Perfume/ }))
  const search = screen.getByRole('combobox', { name: /Buscar perfume/ })
  await user.type(search, 'ambar')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  await user.clear(search)
  await user.type(search, '012345678905')
  await user.keyboard('{Enter}')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Perfume/ })).toHaveTextContent(
    'Ámbar',
  )
  expect(submit).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  expect(submit).toHaveBeenCalledOnce()
})
it('keeps the menu usable with no results and Escape restores focus without choosing', async () => {
  const user = userEvent.setup()
  render(<Form />)
  const trigger = screen.getByRole('button', { name: /Perfume/ })
  await user.click(trigger)
  await user.type(screen.getByRole('combobox'), 'inexistente')
  expect(screen.getByText(/No encontramos/)).toBeVisible()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(screen.getByRole('listbox')).toBeVisible()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  expect(trigger).toHaveTextContent('Selecciona un producto')
})
it('enforces required selection and honors a disabled form', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  const view = render(<Form onSubmit={submit} />)
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  expect(submit).not.toHaveBeenCalled()
  expect(
    screen.getByText('Selecciona un perfume para continuar.'),
  ).toBeVisible()
  view.rerender(<Form disabled onSubmit={submit} />)
  expect(screen.getByRole('button', { name: /Perfume/ })).toBeDisabled()
})
