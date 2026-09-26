import { beforeEach, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dialog } from '@/components/ui'

// jsdom no abre <dialog> modales: basta con marcarlos abiertos.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

/** Una pantalla que quita el diálogo de la página al cerrarlo. */
function Screen() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Editar precios</button>
      {open && (
        <Dialog open title="Oud Nocturno" onClose={() => setOpen(false)}>
          <button onClick={() => setOpen(false)}>Cancelar</button>
        </Dialog>
      )}
    </>
  )
}

it('gives the focus back to the button that opened it when the screen removes it', async () => {
  const user = userEvent.setup()
  render(<Screen />)
  const opener = screen.getByRole('button', { name: 'Editar precios' })
  await user.click(opener)
  await user.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(opener).toHaveFocus())
})

it('leaves the focus alone when the screen moves it somewhere else', async () => {
  function Search() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <input aria-label="Buscar" id="buscar" />
        {open && (
          <Dialog open title="Filtros" onClose={() => setOpen(false)}>
            <button
              onClick={() => {
                setOpen(false)
                document.getElementById('buscar')?.focus()
              }}
            >
              Aplicar
            </button>
          </Dialog>
        )}
      </>
    )
  }
  const user = userEvent.setup()
  render(<Search />)
  await user.click(screen.getByRole('button', { name: 'Aplicar' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await Promise.resolve()
  expect(screen.getByLabelText('Buscar')).toHaveFocus()
})
