-- Permitir renombrar y numerar la cuenta, conservando el vínculo interno que
-- utilizan las recepciones. Su desactivación rompería el flujo automático.
do $$ declare d text; begin
 d:=pg_get_functiondef('private.ledger_account_restriction(text)'::regprocedure);
 if position($needle$'2117','3110-001'$needle$ in d)=0 then raise exception 'No se encontró la lista de cuentas operativas esperada.'; end if;
 d:=replace(d,$needle$'2117','3110-001'$needle$,$replacement$'2117','2190','3110-001'$replacement$);
 execute d;
end $$;
notify pgrst,'reload schema';
