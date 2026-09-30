export interface ScannerAdapter {
  start(onDecode: (code: string) => void): Promise<void>
  stop(): Promise<void>
}
type CameraFailure = 'denied' | 'unavailable' | 'insecure' | 'device'
export class CameraError extends Error {
  constructor(public kind: CameraFailure) {
    super(kind)
  }
}
export function cameraMessage(error: unknown): string {
  const kind = error instanceof CameraError ? error.kind : 'device'
  return {
    denied:
      'El permiso de cámara fue rechazado. Habilítalo en tu navegador y reintenta.',
    unavailable:
      'No encontramos una cámara disponible. Puedes ingresar el código manualmente.',
    insecure:
      'Para usar la cámara, abre la aplicación con HTTPS o desde localhost.',
    device:
      'No pudimos iniciar la cámara. Comprueba que otra aplicación no la esté usando y reintenta.',
  }[kind]
}
