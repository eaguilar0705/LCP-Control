import { rpc } from './workspace'
import { AppError } from '../lib/errors'
import type { OperationReference } from '../lib/operationRecovery'
export interface OperationConfirmation {
  status: 'confirmed' | 'missing' | 'retired'
  id?: string
  number?: string | number
  cancelled?: boolean
}
export async function operationConfirmation(
  reference: OperationReference,
  retire = false,
) {
  const result = await rpc<OperationConfirmation>(
    retire ? 'retire_unconfirmed_operation' : 'get_operation_confirmation',
    {
      p_kind: reference.kind,
      p_request_id: reference.requestId,
    },
  )
  if (!result || !['confirmed', 'missing', 'retired'].includes(result.status))
    throw new AppError(
      'unexpected',
      'No se recibió el estado de la solicitud. Conserva su identificador y vuelve a consultar.',
    )
  return result
}
