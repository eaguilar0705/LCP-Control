import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ProductPicker } from '@/features/sales/ProductPicker'
import { catalogAdapter } from '@/services/adapters/catalog'
it('filters words without accents and adds the exact variant directly from its card', async () => {
  const items = await catalogAdapter.getInventory()
  const onAdd = vi.fn()
  const user = userEvent.setup()
  const view = render(
    <ProductPicker
      items={items}
      currency="NIO"
      tier="emprendedor"
      location="store"
      added={[]}
      onAdd={onAdd}
    />,
  )
  await user.type(screen.getByLabelText('Buscar en catálogo'), 'JAZMIN aurora')
  expect(screen.getAllByRole('article')).toHaveLength(1)
  const add = screen.getByRole('button', {
    name: /^Agregar Aurora Norte Jazmín 02/,
  })
  await user.click(add)
  expect(onAdd).toHaveBeenCalledWith('demo-0002')
  view.rerender(
    <ProductPicker
      items={items}
      currency="USD"
      tier="premium"
      location="store"
      added={['demo-0002']}
      onAdd={onAdd}
    />,
  )
  expect(add).toBeDisabled()
  expect(screen.getByText(/23.00/)).toBeInTheDocument()
})
it('finds a manufacturer code beyond the first page and preserves the product photo', async () => {
  const items = await catalogAdapter.getInventory()
  items[20].product.manufacturerBarcode = '1234567890123'
  items[20].product.imageUrl = '/test-perfume.webp'
  const user = userEvent.setup()
  render(
    <ProductPicker
      items={items}
      currency="NIO"
      tier="vip"
      location="warehouse"
      added={[]}
      onAdd={vi.fn()}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Más perfumes' }))
  await user.type(screen.getByLabelText('Buscar en catálogo'), '1234567890123')
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByRole('img')).toHaveAttribute('src', '/test-perfume.webp')
  await user.clear(screen.getByLabelText('Buscar en catálogo'))
  await user.type(
    screen.getByLabelText('Buscar en catálogo'),
    'zzzz-inexistente',
  )
  expect(screen.getByText('No encontramos ese perfume')).toBeInTheDocument()
  expect(screen.queryAllByRole('article')).toHaveLength(0)
})
