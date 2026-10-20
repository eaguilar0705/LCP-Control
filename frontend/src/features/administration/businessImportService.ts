import type {
  BusinessImportRequest,
  BusinessImportResult,
} from '@lcp/contracts/businessImport'
import { supabase } from '../../lib/supabase'
import { toAppError } from '../../services/adapters/supabase'
import { AppError } from '../../lib/errors'

export async function importBusinessExcel(
  input: BusinessImportRequest,
  preview: boolean,
): Promise<BusinessImportResult> {
  if (!supabase)
    throw new AppError(
      'configuration',
      'Inicia sesión para importar los datos del negocio.',
    )
  const { data, error } = await supabase.rpc('import_business_excel', {
    p_input: input,
    p_preview: preview,
  })
  if (error?.code === 'PGRST202' || error?.code === '42883')
    throw new AppError(
      'configuration',
      'Falta aplicar la actualización de importación de Excel en la base de datos.',
    )
  if (error) throw toAppError(error)
  const result = data as BusinessImportResult | null
  if (
    !result ||
    result.preview !== preview ||
    typeof result.alreadyImported !== 'boolean' ||
    typeof result.business !== 'boolean' ||
    ![
      'products',
      'stocks',
      'accounts',
      'openingBalances',
      'customers',
      'suppliers',
    ].every(
      (key) =>
        Number.isInteger(result[key as keyof BusinessImportResult]) &&
        Number(result[key as keyof BusinessImportResult]) >= 0,
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibió la confirmación de la carga. Reintenta con el mismo archivo.',
    )
  return result
}
