import { useCallback, useState } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { journalRpc } from './journalService'
import {
  MultiCurrencyJournal,
  type AccountingDraft,
} from './MultiCurrencyJournal'
import type { JournalDetailRecord, LedgerReport } from './journalModel'

export function AccountingDrafts({
  data,
  onChanged,
}: {
  data: LedgerReport
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Borradores contables
      </Button>
      {open && (
        <DraftsList
          data={data}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  )
}
function DraftsList({
  data,
  onClose,
  onChanged,
}: {
  data: LedgerReport
  onClose: () => void
  onChanged: () => void
}) {
  const [offset, setOffset] = useState(0)
  const load = useCallback(
    () =>
      journalRpc<(AccountingDraft & { actor_name: string })[]>(
        'accounting_drafts',
        { p_offset: offset },
      ),
    [offset],
  )
  const query = useQuery(load)
  const [selected, setSelected] = useState<AccountingDraft>()
  return (
    <Dialog
      open
      title="Borradores contables"
      onClose={onClose}
      className="journal-dialog"
    >
      {query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : query.loading ? (
        <LoadingState />
      ) : (
        <>
          {!query.data?.length && <p>No hay borradores guardados.</p>}
          {query.data?.map((d) => (
            <article key={d.id} className="day-history-event">
              <div>
                <strong>
                  {d.data.description || 'Comprobante por completar'}
                </strong>
                <p>
                  {d.data.date} · {d.actor_name} · {d.data.reference}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setSelected(d)}>
                Continuar borrador
              </Button>
            </article>
          ))}
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={!offset}
              onClick={() => setOffset(offset - 50)}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              disabled={query.data?.length !== 50}
              onClick={() => setOffset(offset + 50)}
            >
              Siguiente
            </Button>
          </div>
        </>
      )}
      {selected && (
        <DraftEditor
          draft={selected}
          data={data}
          onClose={() => setSelected(undefined)}
          onSaved={() => {
            setSelected(undefined)
            query.retry()
            onChanged()
          }}
        />
      )}
    </Dialog>
  )
}
function DraftEditor({
  draft,
  data,
  onClose,
  onSaved,
}: {
  draft: AccountingDraft
  data: LedgerReport
  onClose: () => void
  onSaved: () => void
}) {
  const load = useCallback(
    () =>
      draft.data.entryId
        ? journalRpc<JournalDetailRecord>('get_journal_entry', {
            p_id: draft.data.entryId,
          })
        : Promise.resolve(null),
    [draft.data.entryId],
  )
  const query = useQuery(load)
  const [pending, setPending] = useState(false)
  return (
    <Dialog
      open
      title="Continuar borrador contable"
      className="journal-dialog"
      dismissible={!pending}
      onClose={() => {
        if (!pending) onClose()
      }}
    >
      {query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : query.loading ? (
        <LoadingState />
      ) : (
        <MultiCurrencyJournal
          entry={query.data ?? undefined}
          initialDraft={draft}
          accounts={
            query.data?.editingAccounts ??
            data.accounts.filter((a) => a.active !== false && a.postable)
          }
          kind={draft.data.kind}
          submitName={draft.data.submitName}
          extraInput={draft.data.extraInput}
          onPending={setPending}
          onSaved={onSaved}
          onCancel={onClose}
        />
      )}
    </Dialog>
  )
}
