import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { ProductImage } from './ProductImage'
import type { Product } from '../lib/domain'

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')

export function ProductSelect({
  label,
  products,
  value,
  onChange,
  required = true,
  disabled = false,
}: {
  label: string
  products: Product[]
  value: string
  onChange: (value: string) => void
  required?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [invalid, setInvalid] = useState(false)
  const selected = products.find((p) => p.id === value)
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  const matches = products.filter((p) =>
    terms.every((term) =>
      normalize(
        `${p.brand} ${p.name} ${p.barcode} ${p.manufacturerBarcode ?? ''} ${p.size ?? ''} ${p.unit}`,
      ).includes(term),
    ),
  )
  const index = Math.min(active, matches.length - 1)
  const expanded = open && !disabled
  useEffect(() => {
    if (!expanded) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [expanded])
  useEffect(() => {
    if (expanded)
      document
        .getElementById(`${id}-option-${index}`)
        ?.scrollIntoView?.({ block: 'nearest' })
  }, [expanded, index, id])
  function choose(product: Product) {
    onChange(product.id)
    setInvalid(false)
    setOpen(false)
    trigger.current?.focus()
  }
  function show() {
    setQuery('')
    setActive(0)
    setOpen(true)
  }
  return (
    <div
      ref={root}
      className={`field product-select ${invalid ? 'field-invalid' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false)
      }}
    >
      <label id={`${id}-label`} htmlFor={`${id}-trigger`}>
        {label}
      </label>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className="product-select-trigger"
        disabled={disabled}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show()
          }
        }}
      >
        {selected && <ProductImage key={selected.id} product={selected} />}
        <span id={`${id}-value`} className="product-select-value">
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              <small>
                {selected.brand} · {selected.size ?? '?'} {selected.unit}
              </small>
            </>
          ) : (
            'Selecciona un producto'
          )}
        </span>
        <ChevronDown size={17} className="product-select-chevron" />
      </button>
      {/* Preserve native required validation without a second visible control. */}
      <select
        className="product-select-validity"
        aria-hidden="true"
        tabIndex={-1}
        required={required}
        disabled={disabled}
        value={selected?.id ?? ''}
        onChange={(event) => onChange(event.target.value)}
        onInvalid={(event) => {
          event.preventDefault()
          setInvalid(true)
          trigger.current?.focus()
        }}
      >
        <option value="" />
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {invalid && (
        <small id={`${id}-error`} className="field-error">
          Selecciona un perfume para continuar.
        </small>
      )}
      {expanded && (
        <div className="product-select-popup">
          <div className="product-select-search">
            <Search size={17} />
            <input
              ref={search}
              role="combobox"
              aria-label={`Buscar perfume: ${label}`}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={
                index >= 0 ? `${id}-option-${index}` : undefined
              }
              value={query}
              placeholder="Nombre, marca o código…"
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setOpen(false)
                  trigger.current?.focus()
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive(
                    matches.length
                      ? (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          matches.length) %
                          matches.length
                      : 0,
                  )
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (matches[index]) choose(matches[index])
                }
              }}
            />
          </div>
          <div className="product-select-count" role="status">
            {matches.length} {matches.length === 1 ? 'perfume' : 'perfumes'}
          </div>
          <div
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="product-select-options"
          >
            {matches.map((p, i) => (
              <div
                id={`${id}-option-${i}`}
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                className={`product-select-option ${i === index ? 'is-highlighted' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(p)}
              >
                <ProductImage key={`${p.id}:${p.imageUrl}`} product={p} />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.brand} · {p.size ?? '?'} {p.unit}
                  </small>
                  <small className="product-select-code">{p.barcode}</small>
                </span>
                {p.id === value && <Check size={17} />}
              </div>
            ))}
          </div>
          {!matches.length && (
            <p className="product-select-empty">
              No encontramos ese perfume. Prueba otra marca o código.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
