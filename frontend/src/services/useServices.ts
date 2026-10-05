import { useAccess } from '../app/AccessContext'
import { demoServices, privateServices } from './index'

// Route scope, not the existence of credentials, chooses the data source.
export function useServices() {
  return useAccess().demo ? demoServices : privateServices
}
