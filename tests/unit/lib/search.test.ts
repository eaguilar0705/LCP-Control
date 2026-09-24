import { describe, expect, it } from 'vitest'
import { matchesSearch, searchable } from '@/lib/search'

describe('búsqueda sin acentos', () => {
  it('quita tildes, mayúsculas y espacios sobrantes', () => {
    expect(searchable('  Jazmín   ÁRABE ')).toBe('jazmin arabe')
    expect(searchable('Ñandú')).toBe('nandu')
  })

  it('encuentra la frase con o sin tildes', () => {
    const text = 'Jazmín 02 Aurora Norte DEMO-0002'
    expect(matchesSearch(text, 'jazmin')).toBe(true)
    expect(matchesSearch(text, 'JAZMÍN 02')).toBe(true)
    expect(matchesSearch(text, 'norte  demo-0002')).toBe(true)
    // La frase completa, no palabras sueltas: «Cedro 01» no debe traer
    // también a «Cedro 11», cuyo código DEMO-0011 contiene «01».
    expect(matchesSearch('Cedro 11 Aurora Norte DEMO-0011', 'cedro 01')).toBe(
      false,
    )
  })

  it('una búsqueda vacía o de espacios coincide con todo', () => {
    expect(matchesSearch('Cualquier cosa', '')).toBe(true)
    expect(matchesSearch('Cualquier cosa', '   ')).toBe(true)
  })
})
