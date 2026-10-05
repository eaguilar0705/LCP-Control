-- New issuer fields default to empty; existing documents retain their original JSON snapshot.
alter table public.business_settings
 add column legal_name text not null default '' check(length(legal_name)<=160),
 add column tax_id text not null default '' check(length(tax_id)<=40),
 add column email text not null default '' check(length(email)<=160),
 add column branch text not null default '' check(length(branch)<=100),
 add column billing_details text not null default '' check(length(billing_details)<=240);

create function private.save_business_profile(p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_name text:=trim(coalesce(p_payload->>'name',''));
 v_legal text:=trim(coalesce(p_payload->>'legalName',''));
 v_tax text:=trim(coalesce(p_payload->>'taxId',''));
 v_address text:=trim(coalesce(p_payload->>'address',''));
 v_phone text:=trim(coalesce(p_payload->>'phone',''));
 v_email text:=trim(coalesce(p_payload->>'email',''));
 v_branch text:=trim(coalesce(p_payload->>'branch',''));
 v_details text:=trim(coalesce(p_payload->>'billingDetails',''));
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if jsonb_typeof(p_payload) is distinct from 'object'
 or length(v_name) not between 1 and 160
 or length(v_legal) not between 1 and 160
 or length(v_tax) not between 1 and 40
 or length(v_address) not between 1 and 600
 or length(v_phone) not between 1 and 60
 or length(v_email)>160 or length(v_branch)>100 or length(v_details)>240
 then raise exception 'Completa nombre comercial, razón social, RUC, dirección y teléfono dentro del límite permitido.'; end if;
 if v_email<>'' and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 then raise exception 'Revisa el correo del negocio.'; end if;
 perform private.limit_catalog_writes();
 insert into public.business_settings(id,name,address,phone,legal_name,tax_id,email,branch,billing_details)
 values(true,v_name,v_address,v_phone,v_legal,v_tax,v_email,v_branch,v_details)
 on conflict(id) do update set name=excluded.name,address=excluded.address,phone=excluded.phone,
 legal_name=excluded.legal_name,tax_id=excluded.tax_id,email=excluded.email,branch=excluded.branch,billing_details=excluded.billing_details;
end $$;
revoke all on function private.save_business_profile(jsonb) from public,anon;
grant execute on function private.save_business_profile(jsonb) to authenticated;
create function public.save_business_profile(p_payload jsonb)
returns void language sql security invoker set search_path='' as $$
 select private.save_business_profile(p_payload);
$$;
revoke all on function public.save_business_profile(jsonb) from public,anon;
grant execute on function public.save_business_profile(jsonb) to authenticated;
-- create_document already snapshots to_jsonb(b)-'id'; it includes these fields automatically.
-- Keep save_business_settings(text,text,text) compatible with older open browser sessions.

