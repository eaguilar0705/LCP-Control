import { createClient } from '@supabase/supabase-js'
const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
const parsedUrl = url ? URL.parse(url) : null
// Fail closed: only modern public keys accepted. No legacy JWT keys or service keys.
export const authConfigured =
  parsedUrl?.protocol === 'https:' && !!key?.startsWith('sb_publishable_')
export const supabase = authConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Flujo implícito: el enlace del correo funciona aunque se abra en otro
        // dispositivo (PKCE exige el mismo navegador del registro).
        flowType: 'implicit',
        // Sólo /auth/callback canjea credenciales de la dirección, de forma
        // explícita (services/auth.ts → confirmAuthLink). Así ninguna otra
        // pantalla consume un enlace ni deja tokens en el historial.
        detectSessionInUrl: false,
      },
    })
  : null
