-- La apertura establece la base del libro; no es movimiento del período.
-- Conservar los saldos finales, comprobantes, importes y metadatos existentes.
-- Se modifica el cálculo base para conservar las capas de compras pendientes
-- y numeración visible que utilizan el mismo mayor.
do $opening_balances$
declare
 definition text;
 marker text;
 replacement text;
begin
 definition:=pg_get_functiondef('private.ledger_report_before_fixed_purchase(date,date)'::regprocedure);
 for marker,replacement in
  select * from (values
   ('select day,account,debit,credit from private.operational_postings',
    'select day,account,debit,credit,false is_opening from private.operational_postings'),
   ('select e.occurred_on,l.account,l.debit_nio,l.credit_nio from public.journal_entries e',
    'select e.occurred_on,l.account,l.debit_nio,l.credit_nio,e.kind=''opening'' is_opening from public.journal_entries e'),
   ('filter(where p.day<p_from)',
    'filter(where p.day<p_from or p.is_opening)'),
   ('filter(where p.day>=p_from)',
    'filter(where p.day>=p_from and not p.is_opening)')
  ) as changes(marker,replacement)
 loop
  if position(marker in definition)=0 then
   raise exception 'Revisar el cálculo de saldos iniciales del mayor: falta %.',marker;
  end if;
  definition:=replace(definition,marker,replacement);
 end loop;
 execute definition;
end $opening_balances$;

notify pgrst,'reload schema';
