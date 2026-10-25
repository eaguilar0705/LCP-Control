-- Las pantallas conservan la instantánea que se abrió. La comparación y la
-- escritura ocurren bajo el mismo bloqueo; una lectura previa en el navegador
-- no protege de un segundo administrador ni de la activación de una cuenta.
alter function public.save_staff_account(text,text,text,boolean) set schema private;
revoke all on function private.save_staff_account(text,text,text,boolean)
 from public,anon,authenticated;

create function public.save_staff_account_checked(
 p_email text,p_name text,p_role text,p_active boolean,p_expected jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare
 v_email text:=lower(trim(p_email));
 v_current jsonb;
 v_desired jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 -- La activación por Auth también bloquea pending_staff antes de crear staff.
 perform 1 from private.pending_staff where email=v_email for update;
 perform 1 from public.staff_members s join auth.users u on u.id=s.user_id
  where lower(u.email)=v_email for update of s;
 select to_jsonb(s) into v_current from public.list_staff_accounts() s
  where lower(s.email)=v_email;
 if p_expected is not null and jsonb_typeof(p_expected) is distinct from 'object' then
  raise exception 'Actualiza los datos del usuario antes de guardar.';
 end if;
 v_desired:=jsonb_build_object('email',v_email,'display_name',trim(p_name),
  'role',p_role,'active',p_active,
  'registered',coalesce((p_expected->>'registered')::boolean,false),
  'user_id',p_expected->'user_id');
 if v_current is distinct from p_expected then
  -- Una respuesta perdida puede reenviar exactamente el guardado ya confirmado.
  -- Se reconoce sin volver a escribir ni sobrescribir cambios posteriores.
  if v_current is not null and v_current=v_desired then return; end if;
  raise exception 'Otro administrador modificó o activó esta cuenta. Actualiza los datos del usuario y revisa sus permisos antes de guardar.';
 end if;
 perform private.save_staff_account(p_email,p_name,p_role,p_active);
end $$;
revoke all on function public.save_staff_account_checked(text,text,text,boolean,jsonb)
 from public,anon;
grant execute on function public.save_staff_account_checked(text,text,text,boolean,jsonb)
 to authenticated;

-- Un navegador antiguo puede autorizar una dirección nueva, pero no restaurar
-- permisos antiguos en una cuenta que otro administrador acaba de cambiar.
create function public.save_staff_account(p_email text,p_name text,p_role text,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 if exists(select 1 from private.pending_staff where email=lower(trim(p_email)))
 or exists(select 1 from auth.users where lower(email)=lower(trim(p_email))) then
  raise exception 'Actualiza la página y vuelve a abrir el usuario antes de cambiar sus permisos.';
 end if;
 perform public.save_staff_account_checked(p_email,p_name,p_role,p_active,null);
end $$;
revoke all on function public.save_staff_account(text,text,text,boolean) from public,anon;
grant execute on function public.save_staff_account(text,text,text,boolean) to authenticated;

create function public.save_business_profile_checked(p_payload jsonb,p_expected jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_current jsonb; v_desired jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 -- La importación usa la función privada existente: su UPDATE adquiere este
 -- mismo bloqueo de fila, por lo que tampoco puede intercalarse con el CAS.
 select jsonb_build_object('name',b.name,'legalName',b.legal_name,'taxId',b.tax_id,
  'address',b.address,'phone',b.phone,'email',b.email,'branch',b.branch,
  'billingDetails',b.billing_details)
 into v_current from public.business_settings b where b.id=true for update;
 if v_current is null then
  raise exception 'No se encontraron los datos del negocio. Actualiza la página o consulta al administrador.';
 end if;
 v_desired:=jsonb_build_object('name',trim(coalesce(p_payload->>'name','')),
  'legalName',trim(coalesce(p_payload->>'legalName','')),
  'taxId',trim(coalesce(p_payload->>'taxId','')),
  'address',trim(coalesce(p_payload->>'address','')),
  'phone',trim(coalesce(p_payload->>'phone','')),
  'email',trim(coalesce(p_payload->>'email','')),
  'branch',trim(coalesce(p_payload->>'branch','')),
  'billingDetails',trim(coalesce(p_payload->>'billingDetails','')));
 if v_current is distinct from p_expected then
  if v_current=v_desired then return; end if;
  raise exception 'Otro administrador modificó los datos del negocio. Actualiza los datos y revisa los cambios antes de guardar.';
 end if;
 perform private.save_business_profile(p_payload);
end $$;
revoke all on function public.save_business_profile_checked(jsonb,jsonb) from public,anon;
grant execute on function public.save_business_profile_checked(jsonb,jsonb) to authenticated;

-- Evitar una escritura sin comparación desde versiones antiguas del programa.
-- La importación autorizada sigue usando private.save_business_profile.
revoke all on function private.save_business_profile(jsonb) from public,anon,authenticated;
create or replace function public.save_business_profile(p_payload jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 raise exception 'Actualiza la página antes de guardar los datos del negocio.';
end $$;
create or replace function public.save_business_settings(p_name text,p_address text,p_phone text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then
  raise insufficient_privilege;
 end if;
 raise exception 'Actualiza la página antes de guardar los datos del negocio.';
end $$;
