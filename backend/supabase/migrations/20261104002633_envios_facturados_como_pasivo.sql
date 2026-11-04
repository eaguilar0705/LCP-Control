-- El envío cobrado en una factura se recibe por cuenta del transportista.
-- El pago y el traslado de cualquier diferencia a ingreso son manuales.
insert into public.ledger_accounts(code,name,parent,bucket,nature,postable) values
 ('2117','Envíos por pagar','2100','liability','credit',true),
 ('4190-001','Gestión de envíos','4190','revenue','credit',true);

-- Conservar la cuenta retirada para imprimir comprobantes históricos, incluso
-- los anulados. No mover ni borrar renglones que haya registrado el usuario.
update public.ledger_accounts set active=false where code='4120';

create or replace view private.operational_postings as
 select o.day,o.source,o.source_id,
  case when o.source='expense' and o.debit>0 and e.category='envios' then '5130-011'
   when o.source='expense' and o.credit>0 and e.account='banco' then coalesce(e.bank_ledger_account,o.account)
   else o.account end account,o.debit,o.credit
 from private.operational_postings_before_shipping o left join public.expense_records e on o.source='expense' and e.id=o.source_id
 union all
 select (d.created_at at time zone 'America/Managua')::date,'sale',d.id,
  private.sale_ledger_account(d.payment_method,d.currency),d.shipping_nio,0::numeric
 from public.documents d where d.kind='invoice' and d.shipping_nio>0
  and not exists(select 1 from public.invoice_payments ip where ip.document_id=d.id)
 union all
 select (d.created_at at time zone 'America/Managua')::date,'sale',d.id,'2117',0::numeric,d.shipping_nio
 from public.documents d where d.kind='invoice' and d.shipping_nio>0;
revoke all on private.operational_postings from public,anon,authenticated;

-- Ocultar cuentas retiradas sin movimientos vigentes. Si hubo un asiento real
-- en una cuenta retirada, sus cifras siguen apareciendo en los estados.
do $ledger$ declare definition text; marker text; begin
 definition:=pg_get_functiondef('private.ledger_report(date,date)'::regprocedure);
 marker:='from public.ledger_accounts a left join postings p on p.account=a.code group by a.code';
 if position(marker in definition)=0 then raise exception 'Revisar la lectura de cuentas del mayor.'; end if;
 definition:=replace(definition,marker,'from public.ledger_accounts a left join postings p on p.account=a.code where a.active or exists(select 1 from postings historical where historical.account=a.code) group by a.code');
 marker:='''postable'',postable,''opening'',opening';
 if position(marker in definition)=0 then raise exception 'Revisar los datos de cuentas del mayor.'; end if;
 definition:=replace(definition,marker,'''postable'',postable,''active'',active,''opening'',opening');
 execute definition;
end $ledger$;

notify pgrst,'reload schema';
