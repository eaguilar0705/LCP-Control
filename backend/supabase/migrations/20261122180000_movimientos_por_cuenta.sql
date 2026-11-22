-- El detalle usa los mismos movimientos operativos y renglones de comprobantes
-- que la balanza. La apertura se conserva en el saldo inicial.
create function private.ledger_account_movements(
  p_account text, p_from date, p_to date, p_offset integer
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_opened_on date;
  v_nature text;
  v_sign integer;
  v_result jsonb;
begin
  if auth.uid() is null or private.staff_role() is distinct from 'admin' then
    raise insufficient_privilege;
  end if;
  if p_to is null or not isfinite(p_to)
    or (p_from is not null and (not isfinite(p_from) or p_from > p_to))
    or p_offset is null or p_offset < 0 then
    raise exception 'Período o página de movimientos inválidos.';
  end if;

  select a.nature into v_nature
  from public.ledger_accounts a
  where a.code = p_account and a.postable and a.code <> '2190';
  if not found then
    raise exception 'Selecciona una cuenta contable de movimiento.';
  end if;
  v_sign := case when v_nature = 'credit' then -1 else 1 end;

  select e.occurred_on into v_opened_on
  from public.journal_entries e
  where e.kind = 'opening' and e.voided_at is null;

  with incomplete_invoices as materialized (
    select d.id, (d.created_at at time zone 'America/Managua')::date as day,
      p_account = private.sale_ledger_account(d.payment_method, d.currency)
        and not exists (
          select 1 from public.invoice_payments p where p.document_id = d.id
        ) direct_payment
    from public.documents d
    where d.kind = 'invoice'
      and (d.created_at at time zone 'America/Managua')::date between v_opened_on and p_to
      and (p_account in ('4110', '2116', '5120', '1130')
        or p_account = private.sale_ledger_account(d.payment_method, d.currency))
      and private.credit_invoice_amount(d.id) is null
  ),
  postings as (
    select p.day, case when p.source = 'tax' then 'sale' else p.source end source,
      p.source_id, p.debit, p.credit
    from private.operational_postings p
    where p.account = p_account and p.day between v_opened_on and p_to
    union all
    select e.occurred_on, case when e.kind = 'opening' then 'opening' else 'journal' end,
      e.id, l.debit_nio, l.credit_nio
    from public.journal_entries e
    join private.receipt_normalized_journal_lines l on l.entry_id = e.id
    where l.account = p_account and e.voided_at is null and e.occurred_on <= p_to
    union all
    -- Una factura histórica incompleta puede carecer de sus renglones en el
    -- mayor. Identificar sus cuentas conocidas sin inventar un importe.
    select i.day, 'sale', i.id, null::numeric, 0::numeric
    from incomplete_invoices i where i.direct_payment
    union all
    select i.day, 'sale', i.id, 0::numeric, null::numeric
    from incomplete_invoices i
    where p_account = '4110' or (p_account = '2116' and exists (
      select 1 from public.document_item_costs c where c.document_id = i.id and c.tax_nio > 0
    ))
    union all
    select i.day, 'cost', i.id,
      case when p_account = '1130' then 0::numeric end,
      case when p_account = '5120' then 0::numeric end
    from incomplete_invoices i where p_account in ('5120', '1130')
  ),
  movements as materialized (
    select p.day, p.source, p.source_id,
      case when not bool_or(p.debit is null) then sum(p.debit) end debit,
      case when not bool_or(p.credit is null) then sum(p.credit) end credit
    from postings p
    group by p.day, p.source, p.source_id
    having bool_or(p.debit is null or p.credit is null or p.debit <> 0 or p.credit <> 0)
  ),
  initial_balance as (
    select case
      when v_opened_on <= p_to and not coalesce(bool_or(m.debit is null or m.credit is null), false)
      then v_sign * coalesce(sum(m.debit - m.credit), 0)
    end amount
    from movements m
    where m.source = 'opening' or m.day < p_from
  ),
  period as materialized (
    select m.source || ':' || m.source_id::text id, m.day, m.debit, m.credit,
      coalesce(e.created_at, d.created_at, s.created_at, c.created_at, f.created_at,
        x.created_at, i.created_at) recorded_at,
      e.number journal_number,
      case m.source
        when 'journal' then case
          when exists (select 1 from public.sales_returns r where r.journal_entry_id = e.id)
            then 'Devolución de venta'
          when exists (select 1 from private.receipt_revisions r where r.journal_entry_id = e.id)
            then 'Corrección de recepción'
          when exists (select 1 from private.purchase_classifications c where c.entry_id = e.id)
            then 'Compra'
          when exists (select 1 from private.inventory_adjustment_voids v where v.journal_entry_id = e.id)
            then 'Anulación de ajuste de inventario'
          when exists (select 1 from private.inventory_adjustment_journals j where j.entry_id = e.id)
            then 'Ajuste de inventario'
          else case e.kind
            when 'income' then 'Comprobante de ingreso'
            when 'expense' then 'Comprobante de egreso'
            when 'deposit' then 'Minuta de depósito'
            when 'transfer' then 'Transferencia bancaria'
            when 'card_settlement' then 'Liquidación de tarjetas'
            when 'adjustment' then 'Comprobante de ajuste'
            else 'Comprobante'
          end
        end
        when 'sale' then case when p_account = '2117' then 'Envío facturado' else 'Factura' end
        when 'cost' then 'Costo de venta'
        when 'purchase' then 'Compra'
        when 'purchase_correction' then 'Corrección de compra'
        when 'purchase_refund' then 'Reintegro de compra'
        when 'expense' then case when x.category = 'envios' then 'Pago de envío' else 'Gasto' end
        when 'finance' then case f.kind
          when 'capital' then 'Aporte de capital'
          when 'withdrawal' then 'Retiro'
          when 'transfer' then 'Traslado'
          when 'loan' then 'Préstamo'
          when 'supplier_payment' then 'Pago a proveedor'
          when 'collection' then 'Cobro a cliente'
          else 'Movimiento financiero'
        end
        when 'writeoff' then 'Salida de inventario'
        when 'count_gain' then 'Sobrante de inventario'
        else 'Movimiento contable'
      end source,
      coalesce(e.description, nullif(d.customer_name, ''), c.reason,
        nullif(s.supplier, ''), x.description, nullif(f.description, ''),
        nullif(f.counterparty, ''), nullif(i.note, ''), '') description,
      coalesce(nullif(e.reference, ''),
        'CP-' || lpad(e.number::text, greatest(6, length(e.number::text)), '0'),
        d.number, nullif(s.reference, ''), nullif(x.reference, ''),
        nullif(f.reference, ''), i.reference, '') reference
    from movements m
    left join public.journal_entries e on m.source = 'journal' and e.id = m.source_id
    left join public.documents d on m.source in ('sale', 'cost') and d.id = m.source_id
    left join public.purchase_corrections c on m.source in ('purchase_correction', 'purchase_refund')
      and c.id = m.source_id
    left join public.purchase_shipments s on s.id = case
      when m.source = 'purchase' then m.source_id else c.shipment_id
    end
    left join public.expense_records x on m.source = 'expense' and x.id = m.source_id
    left join public.finance_entries f on m.source = 'finance' and f.id = m.source_id
    left join public.inventory_movements i on m.source in ('writeoff', 'count_gain') and i.id = m.source_id
    where m.source <> 'opening' and (p_from is null or m.day >= p_from)
  ),
  totals as (
    select count(*) total,
      case when v_opened_on <= p_to and not coalesce(bool_or(p.debit is null), false)
        then coalesce(sum(p.debit), 0) end debit,
      case when v_opened_on <= p_to and not coalesce(bool_or(p.credit is null), false)
        then coalesce(sum(p.credit), 0) end credit,
      bit_xor(hashtextextended(to_jsonb(p)::text, 0)) fingerprint
    from period p
  ),
  page as (
    select p.*, case when not bool_or(p.debit is null or p.credit is null) over chronological
      then b.amount + v_sign * sum(p.debit - p.credit) over chronological
    end balance
    from period p cross join initial_balance b
    window chronological as (
      order by p.day, p.recorded_at, p.journal_number, p.id rows unbounded preceding
    )
    order by p.day, p.recorded_at, p.journal_number, p.id
    offset p_offset limit 50
  )
  select jsonb_build_object(
    'account', p_account, 'from', p_from, 'to', p_to, 'offset', p_offset,
    'total', t.total, 'opening', b.amount, 'debit', t.debit, 'credit', t.credit,
    'closing', b.amount + v_sign * (t.debit - t.credit),
    'revision', md5(jsonb_build_array(p_account, p_from, p_to, v_opened_on, v_nature,
      b.amount, t.total, t.debit, t.credit, t.fingerprint)::text),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'day', p.day, 'source', p.source, 'description', p.description,
          'reference', p.reference, 'debit', p.debit, 'credit', p.credit, 'balance', p.balance
        ) order by p.day, p.recorded_at, p.journal_number, p.id
      ) from page p
    ), '[]'::jsonb)
  ) into v_result
  from initial_balance b cross join totals t;
  return v_result;
end;
$$;
revoke all on function private.ledger_account_movements(text,date,date,integer) from public,anon;
grant execute on function private.ledger_account_movements(text,date,date,integer) to authenticated;

create function public.ledger_account_movements(
  p_account text, p_from date, p_to date, p_offset integer default 0
) returns jsonb
language sql stable security invoker set search_path='' as $$
  select private.ledger_account_movements(p_account, p_from, p_to, p_offset);
$$;
revoke all on function public.ledger_account_movements(text,date,date,integer) from public,anon;
grant execute on function public.ledger_account_movements(text,date,date,integer) to authenticated;

notify pgrst,'reload schema';
