import { createClient } from '@supabase/supabase-js'
const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
const parsedUrl = url ? URL.parse(url) : null

/**
 * Claves que supabase-js usaba al guardar la sesión en el navegador
 * (`sb-<proyecto>-auth-token`, su copia `-user` y el verificador PKCE).
 */
const storedAuthKey = /^sb-.+-auth-token(?:-user|-code-verifier)?$/

/**
 * Borra de localStorage y sessionStorage cualquier sesión que haya dejado una
 * versión anterior del programa (tokens de acceso y de renovación, correo).
 * Devuelve cuántas claves borró. Nunca falla: sin almacenamiento no hay nada
 * que borrar.
 */
export function purgeStoredCredentials(
  stores: (Storage | undefined)[] = [
    globalThis.localStorage,
    globalThis.sessionStorage,
  ],
): number {
  let removed = 0
  for (const store of stores) {
    try {
      if (!store) continue
      const keys = Array.from({ length: store.length }, (_, i) => store.key(i))
      for (const name of keys)
        if (name && storedAuthKey.test(name)) {
          store.removeItem(name)
          removed++
        }
    } catch {
      // Almacenamiento bloqueado por el navegador: no hay nada que borrar.
    }
  }
  return removed
}

/**
 * Ninguna respuesta de Supabase (tokens, perfil, datos del negocio) se guarda
 * en la caché HTTP del navegador ni se sirve desde ella.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: 'no-store' })

// Fail closed: only modern public keys accepted. No legacy JWT keys or service keys.
export const authConfigured =
  parsedUrl?.protocol === 'https:' && !!key?.startsWith('sb_publishable_')

// Las credenciales viven sólo en la memoria de la pestaña (decisión del
// 26-09-2026): nada de localStorage, sessionStorage, IndexedDB ni cookies.
// Recargar la página, abrir otra pestaña o cerrar el navegador pide la
// contraseña otra vez; así una computadora compartida nunca queda con una
// sesión abierta ni con un token de renovación escrito en el disco.
purgeStoredCredentials()

export const supabase = authConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        // Flujo implícito: el enlace del correo funciona aunque se abra en otro
        // dispositivo (PKCE exige el mismo navegador del registro).
        flowType: 'implicit',
        // Sólo /auth/callback canjea credenciales de la dirección, de forma
        // explícita (services/auth.ts → confirmAuthLink). Así ninguna otra
        // pantalla consume un enlace ni deja tokens en el historial.
        detectSessionInUrl: false,
      },
      global: { fetch: noStoreFetch },
    })
  : null
