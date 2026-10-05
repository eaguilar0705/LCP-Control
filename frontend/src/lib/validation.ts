import { z } from 'zod'
export const quantitySchema = z
  .number()
  .int('Usa una cantidad entera.')
  .positive('La cantidad debe ser mayor que cero.')
  .max(Number.MAX_SAFE_INTEGER)
export const barcodeSchema = z
  .string()
  .trim()
  .min(1, 'El código está vacío.')
  .max(128, 'El código es demasiado largo.')
  .refine(
    (value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    'El código no es válido.',
  )
export const loginSchema = z.object({
  email: z.email('Ingresa un correo válido.'),
  password: z.string().min(1, 'Ingresa tu contraseña.'),
})
