import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { AlertsPage } from '@/features/alerts/AlertsPage'
import { AccessContext } from '@/app/AccessContext'
import { createServices } from '@/services'
import { catalogAdapter } from '@/services/adapters/catalog'
import type { InventoryItem } from '@/lib/domain'

vi.mock('@/services/useServices', () => ({ useServices: () => services }))
const services = createServices(catalogAdapter)
let catalogue: InventoryItem[] = []
beforeEach(async () => {
  catalogue = (await catalogAdapter.getInventory()).slice(0, 3)
})
function mount(items: InventoryItem[]) {
  services.inventoryService.getInventory = async () => items
  render(
    <MemoryRouter>
      <AccessContext.Provider value={{ demo: false, base: '', role: 'admin' }}>
        <AlertsPage />
      </AccessContext.Provider>
    </MemoryRouter>,
  )
}
const withStock = (
  item: InventoryItem,
  quantities: InventoryItem['quantities'],
  minimumStock: number | null,
) => ({ ...item, quantities, product: { ...item.product, minimumStock } })

it('explica que faltan conteos y mínimos, como en la base real de hoy', async () => {
  mount(
    catalogue.map((item) =>
      withStock(item, { warehouse: null, store: null }, 0),
    ),
  )
  expect(
    await screen.findByRole('heading', { name: 'Conteos pendientes' }),
  ).toBeInTheDocument()
  expect(screen.getByText(/3 perfumes no tienen conteo/)).toBeInTheDocument()
  expect(screen.getByText(/Ningún perfume tiene un mínimo/)).toBeInTheDocument()
})

it('no dice «conteos pendientes» si todo está contado pero sin mínimos', async () => {
  mount(catalogue.map((item) => withStock(item, { warehouse: 2, store: 1 }, 0)))
  expect(
    await screen.findByRole('heading', { name: 'Sin mínimos configurados' }),
  ).toBeInTheDocument()
})

it('dice que no hay alertas cuando nada baja de su mínimo', async () => {
  mount(catalogue.map((item) => withStock(item, { warehouse: 2, store: 1 }, 2)))
  expect(
    await screen.findByRole('heading', { name: 'Sin alertas' }),
  ).toBeInTheDocument()
})

it('lista los perfumes por debajo del mínimo', async () => {
  const [low, ...rest] = catalogue
  mount([
    withStock(low, { warehouse: 0, store: 1 }, 4),
    ...rest.map((item) => withStock(item, { warehouse: 5, store: 5 }, 2)),
  ])
  expect(await screen.findByText(low.product.name)).toBeInTheDocument()
  expect(screen.queryByText(rest[0].product.name)).not.toBeInTheDocument()
})
