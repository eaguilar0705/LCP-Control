import { useEffect, useId, useRef, useState } from 'react'
import { Check, UserRound } from 'lucide-react'
import { Button } from '../../components/ui'
import type { ContactRecord } from '../../services/workspace'
import { matchesSearch } from '../../lib/search'
import './customer-autocomplete.css'

export function CustomerAutocomplete({
  value,
  customers,
  selected,
  loading,
  error,
  maxLength,
  onChange,
  onSelect,
  onClear,
}: {
  value: string
  customers: ContactRecord[]
  selected: boolean
  loading: boolean
  error?: string
  maxLength: number
  onChange: (value: string) => void
  onSelect: (customer: ContactRecord) => void
  onClear: () => void
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const suggestions = customers
    .filter(
      (customer) =>
        customer.active &&
        matchesSearch(
          `${customer.name} ${customer.phone} ${customer.taxId ?? ''}`,
          value,
        ),
    )
    .slice(0, 8)
  const expanded = open && !selected
  const index = active < suggestions.length ? active : -1
  useEffect(() => {
    if (expanded && index >= 0)
      document
        .getElementById(`${id}-option-${index}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [expanded, index, id])
  function choose(customer: ContactRecord) {
    onSelect(customer)
    setOpen(false)
    setActive(-1)
  }
  return (
    <div
      className="customer-autocomplete"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false)
      }}
    >
      <label className={`field ${error ? 'field-invalid' : ''}`} htmlFor={id}>
        <span id={`${id}-label`}>Cliente</span>
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-labelledby={`${id}-label`}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-list` : undefined}
          aria-activedescendant={
            expanded && index >= 0 ? `${id}-option-${index}` : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          autoComplete="off"
          placeholder="Nombre, teléfono o RUC"
          maxLength={maxLength}
          value={value}
          disabled={selected}
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
        {error && (
          <small id={`${id}-error`} className="field-error">
            {error}
          </small>
        )}
      </label>
      {selected && (
        <div className="customer-selected">
          <span>
            <Check size={14} aria-hidden="true" />
            Cliente registrado
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onClear()
              setOpen(true)
              setActive(-1)
              requestAnimationFrame(() => input.current?.focus())
            }}
          >
            Cambiar cliente
          </Button>
        </div>
      )}
      {expanded && (
        <div className="customer-suggestions">
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Clientes registrados"
            className="customer-suggestions-list"
          >
            {suggestions.map((customer, position) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-option-${position}`}
                key={customer.id}
                aria-selected={position === index}
                className={`customer-suggestion ${position === index ? 'is-highlighted' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(customer)}
              >
                <UserRound size={18} aria-hidden="true" />
                <span>
                  <strong>{customer.name}</strong>
                  {(customer.phone || customer.taxId) && (
                    <small>
                      {[
                        customer.phone,
                        customer.taxId ? `RUC ${customer.taxId}` : '',
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
            <p className="customer-suggestion-status" role="status">
              Cargando clientes…
            </p>
          ) : (
            !suggestions.length && (
              <p className="customer-suggestion-status" role="status">
                Sin coincidencias. Puedes usar el nombre escrito.
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}
