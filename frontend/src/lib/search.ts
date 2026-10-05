/**
 * Texto comparable para las búsquedas de las listas: sin acentos, sin
 * mayúsculas y sin espacios sobrantes. En el teléfono casi nadie escribe las
 * tildes, así que «jazmin» tiene que encontrar «Jazmín» y «nacar», «Nácar»,
 * igual que ya lo hace el buscador del catálogo al facturar.
 */
export function searchable(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * ¿El texto contiene lo buscado, sin importar tildes ni mayúsculas? Se busca
 * la frase completa, como antes: «Cedro 01» encuentra sólo ese perfume y no
 * también «Cedro 11 · DEMO-0011», que tiene «01» en el código. Una búsqueda
 * vacía coincide con todo.
 */
export function matchesSearch(text: string, query: string) {
  return searchable(text).includes(searchable(query))
}
