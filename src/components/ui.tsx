import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { AlertCircle, LoaderCircle, PackageOpen, X } from 'lucide-react'
export function Button({
  className = '',
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost'
}) {
  return (
    <button className={`button button-${variant} ${className}`} {...props} />
  )
}
// `error` marca el control como inválido y enlaza el mensaje con
// aria-describedby, para que un lector de pantalla lo anuncie al enfocarlo y no
// sólo se vea el color. Los formularios pueden buscar [aria-invalid="true"]
// para llevar el foco al primer campo con problema.
export function Input({
  label,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const id = useId()
  return (
    <label className={`field ${error ? 'field-invalid' : ''}`} htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      {/* El nombre accesible se toma del rótulo, no de todo el contenido de la
          etiqueta: sin esto el mensaje de error pasaría a formar parte del
          nombre del campo y los lectores de pantalla leerían ambos juntos. */}
      <input
        id={id}
        aria-labelledby={`${id}-label`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error && (
        <small className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </label>
  )
}
export function Select({
  label,
  error,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  error?: string
}) {
  const id = useId()
  return (
    <label className={`field ${error ? 'field-invalid' : ''}`} htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <select
        id={id}
        aria-labelledby={`${id}-label`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      >
        {children}
      </select>
      {error && (
        <small className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </label>
  )
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'warning' | 'danger' | 'success'
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <section className={`card ${className}`}>{children}</section>
}
export function LoadingState() {
  return (
    <div className="state" role="status">
      <LoaderCircle className="spin" size={28} />
      <p>Cargando información…</p>
    </div>
  )
}
export function EmptyState({
  title = 'No hay resultados',
  description = 'Prueba con otra búsqueda o cambia los filtros.',
}: {
  title?: string
  description?: string
}) {
  return (
    <div className="state">
      <PackageOpen size={32} />
      {/* Encabeza la sección donde aparece, casi siempre justo bajo el título
          de la pantalla: un h3 ahí deja un nivel sin usar. */}
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}
export function ErrorState({
  message,
  retry,
}: {
  message: string
  retry?: () => void
}) {
  return (
    <div className="state error" role="alert">
      <AlertCircle size={28} />
      <p>{message}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Reintentar
        </Button>
      )}
    </div>
  )
}
export function Feedback({ children }: { children: ReactNode }) {
  return (
    <div className="feedback" role="status">
      {children}
    </div>
  )
}
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (open) dialog?.showModal()
    else dialog?.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <div className="section-heading">
        <h2 id={titleId}>{title}</h2>
        <Button
          type="button"
          variant="ghost"
          aria-label="Cerrar"
          onClick={onClose}
        >
          <X size={20} />
        </Button>
      </div>
      {children}
    </dialog>
  )
}
