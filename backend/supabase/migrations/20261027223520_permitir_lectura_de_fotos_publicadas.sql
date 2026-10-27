-- Storage consulta los metadatos antes de entregar un objeto privado.
-- Solo se permiten ambas operaciones para fotografías de publicaciones visibles.
alter policy storefront_media_published_read on storage.objects
 using (
  bucket_id='storefront-media'
  and storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info'])
  and exists(select 1 from public.storefront_publications p
   where p.visible and p.content->'images' @>
    jsonb_build_array(jsonb_build_object('kind','upload','path',storage.objects.name)))
 );
