-- La comisión, la retención y el neto mantienen sus importes originales USD.
-- Convertir cada renglón por separado puede dejar uno o dos centavos NIO.
-- Sólo en la liquidación POS calculada y validada se asigna esa diferencia
-- al banco que recibe el neto; los comprobantes manuales siguen siendo exactos.
do $migration$
declare v_definition text;
 v_anchor text:=$anchor$ if v_total<>0 or (select sum(debit-credit) from public.journal_lines where entry_id=v_id)<>0 then raise exception 'El debe y el haber deben ser iguales, también al convertir a córdobas.'; end if;$anchor$;
 v_adjustment text:=$adjustment$
 -- Distribuir únicamente el redondeo NIO de una liquidación POS en dólares.
 if p_input->>'kind'='card_settlement' and p_input->>'currency'='USD'
  and v_total<>0 and abs(v_total)<=0.02
  and (select sum(debit-credit) from public.journal_lines where entry_id=v_id)=0
  and (select count(*) from public.journal_lines where entry_id=v_id
   and account=p_input->>'bankAccount' and debit>0 and credit=0)=1
  and exists(select 1 from public.journal_lines where entry_id=v_id
   and account=p_input->>'bankAccount' and debit>0 and credit=0 and debit_nio-v_total>=0) then
  update public.journal_lines set debit_nio=debit_nio-v_total
   where entry_id=v_id and account=p_input->>'bankAccount' and debit>0 and credit=0;
  select sum(debit_nio-credit_nio) into v_total from public.journal_lines where entry_id=v_id;
 end if;
$adjustment$;
begin
 v_definition:=pg_get_functiondef('private.record_journal_entry(jsonb)'::regprocedure);
 if position(v_anchor in v_definition)=0
  or position($guard$v_lines<>p_input->'lines'$guard$ in v_definition)=0 then
  raise exception 'No se encontró la validación de liquidaciones POS esperada.';
 end if;
 if position('Distribuir únicamente el redondeo NIO de una liquidación POS en dólares.' in v_definition)=0 then
  execute replace(v_definition,v_anchor,v_adjustment||v_anchor);
 end if;
end $migration$;

notify pgrst,'reload schema';
