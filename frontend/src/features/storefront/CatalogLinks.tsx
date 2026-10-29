import { Copy, Check, ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui'
import { type CatalogLink } from './storefront'
export function CatalogLinks({
  links,
  onNotice,
  selected,
  onSelect,
}: {
  links: CatalogLink[]
  onNotice: (text: string) => void
  selected: string
  onSelect: (code: string) => void
}) {
  const [copied, setCopied] = useState('')
  return (
    <section
      className="sf-catalog-links"
      aria-label="Enlaces de los cuatro catálogos"
    >
      <h2>Catálogos para compartir</h2>
      {selected && (
        <Button variant="ghost" onClick={() => onSelect('')}>
          Ver todas las listas
        </Button>
      )}
      <div className="sf-catalog-links-grid">
        {links.map((link) => {
          const url = new URL(
            import.meta.env.VITE_STOREFRONT_URL ||
              'https://lcp-control-catalogo.pages.dev/',
          )
          url.searchParams.set('catalogo', link.token)
          const href = url.toString()
          return (
            <article key={link.code}>
              <span className="eyebrow">CATÁLOGO</span>
              <button
                className="sf-catalog-select"
                aria-pressed={selected === link.code}
                onClick={() => onSelect(link.code)}
              >
                <h3>{link.name}</h3>
                <span>
                  {selected === link.code
                    ? 'Lista seleccionada'
                    : 'Ver precios de esta lista'}
                </span>
              </button>
              <input
                aria-label={`Enlace de ${link.name}`}
                readOnly
                value={href}
                onFocus={(e) => e.target.select()}
              />
              <div className="sf-actions">
                <Button
                  variant="secondary"
                  aria-label={`Copiar enlace de ${link.name}`}
                  onClick={async () => {
                    try {
                      if (!navigator.clipboard)
                        throw new Error('Portapapeles no disponible')
                      await navigator.clipboard.writeText(href)
                      setCopied(link.code)
                      onNotice(`Enlace de ${link.name} copiado.`)
                    } catch {
                      onNotice('Selecciona el enlace para copiarlo.')
                    }
                  }}
                >
                  {copied === link.code ? (
                    <Check size={15} />
                  ) : (
                    <Copy size={15} />
                  )}{' '}
                  {copied === link.code ? 'Copiado' : 'Copiar enlace'}
                </Button>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Abrir catálogo ${link.name}`}
                >
                  <ArrowUpRight size={19} />
                </a>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
