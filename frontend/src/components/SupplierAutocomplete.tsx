import { useEffect, useId, useState } from 'react'
import { Truck } from 'lucide-react'
import { listContacts, type ContactRecord } from '../services/workspace'
import { useQuery } from '../lib/useQuery'
import { matchesSearch } from '../lib/search'
import './supplier-autocomplete.css'

const loadSuppliers = () => listContacts('suppliers')

export function SupplierAutocomplete({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const { data, loading, error, retry } = useQuery(loadSuppliers)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const matches = (data ?? []).filter(
    (supplier) =>
      supplier.active &&
      matchesSearch(
        `${supplier.name} ${supplier.phone} ${supplier.taxId}`,
        value,
      ),
  )
  const suggestions = matches.slice(0, 8)
  const expanded = open && !disabled
  const index = active < suggestions.length ? active : -1
  useEffect(() => {
    if (expanded && index >= 0)
      document
        .getElementById(`${id}-option-${index}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [expanded, index, id])
  function choose(supplier: ContactRecord) {
    onChange(supplier.name)
    setOpen(false)
    setActive(-1)
  }
  return (
    <div
      className="supplier-autocomplete"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false)
      }}
    >
      <label className="field" htmlFor={id}>
        <span id={`${id}-label`}>Proveedor</span>
        <input
          id={id}
          role="combobox"
          aria-labelledby={`${id}-label`}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-list` : undefined}
          aria-activedescendant={
            expanded && index >= 0 ? `${id}-option-${index}` : undefined
          }
          autoComplete="off"
          maxLength={160}
          value={value}
          disabled={disabled}
          onFocus={() => {
            setOpen(true)
            setActive(-1)
          }}
          onChange={(event) => {
            onChange(event.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setActive(
                suggestions.length
                  ? index < 0
                    ? event.key === 'ArrowDown'
                      ? 0
                      : suggestions.length - 1
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        suggestions.length) %
                      suggestions.length
                  : -1,
              )
            } else if (event.key === 'Enter' && expanded) {
              // Elegir un proveedor nunca envía la compra accidentalmente.
              event.preventDefault()
              if (index >= 0) choose(suggestions[index])
              else setOpen(false)
            } else if (event.key === 'Escape' && expanded) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
        />
      </label>
      {expanded && (
        <div className="supplier-suggestions">
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Proveedores registrados"
            className="supplier-suggestions-list"
          >
            {suggestions.map((supplier, position) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-option-${position}`}
                key={supplier.id}
                aria-selected={position === index}
                className={`supplier-suggestion ${position === index ? 'is-highlighted' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(supplier)}
              >
                <Truck size={18} aria-hidden="true" />
                <span>
                  <strong>{supplier.name}</strong>
                  {(supplier.phone || supplier.taxId) && (
                    <small>
                      {[
                        supplier.phone,
                        supplier.taxId ? `RUC ${supplier.taxId}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  )}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <p className="supplier-suggestion-status" role="status">
              Cargando proveedores…
            </p>
          ) : error ? (
            <div className="supplier-suggestion-status" role="status">
              <span>
                No se pudieron cargar las sugerencias. Puedes escribir el
                nombre.
              </span>
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  retry()
                  document.getElementById(id)?.focus()
                }}
              >
                Reintentar
              </button>
            </div>
          ) : !suggestions.length ? (
            <p className="supplier-suggestion-status" role="status">
              {value.trim()
                ? 'Sin coincidencias. Puedes usar el nombre escrito.'
                : 'No hay proveedores registrados.'}
            </p>
          ) : matches.length > suggestions.length ? (
            <p className="supplier-suggestion-status">
              Escribe más para filtrar los proveedores.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
