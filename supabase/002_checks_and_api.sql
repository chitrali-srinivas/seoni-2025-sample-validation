-- =====================================================================
-- Seoni K25 sample validation — STEP 2: rule checks + app functions
--
-- Run after 001_schema.sql AND after the four CSVs are imported.
-- Creates objects in schema "seoni" only; never drops anything.
-- If you re-import the CSVs later, run:   select seoni.refresh_checks();
-- =====================================================================

set search_path = seoni, public, extensions;

-- ---------------------------------------------------------------------
-- Spatial facts used for the system's suggested answer
-- ---------------------------------------------------------------------

-- Treatment plot vs control plots
create materialized view if not exists seoni.mv_treatment_plot_checks as
select
  t.plot_id,
  t.farmer_id,
  t.village_name,
  round(st_area(t.geom::geography)::numeric, 1)                         as plot_area_m2,
  coalesce(o.n, 0)::int                                                 as overlapping_control_count,
  round(coalesce(o.overlap_m2, 0)::numeric, 2)                          as control_overlap_m2,
  case when st_area(t.geom::geography) > 0
       then round((coalesce(o.overlap_m2, 0) / st_area(t.geom::geography) * 100)::numeric, 2)
       else 0 end                                                       as control_overlap_pct,
  o.control_plot_ids,
  exists (select 1 from seoni.control_plots c where c.plot_id = t.plot_id) as plot_id_reused_as_control,
  exists (select 1 from seoni.treatment_samples s where s.plot_id = t.plot_id) as has_samples
from seoni.treatment_plots t
left join lateral (
  select count(*) as n, sum(a) as overlap_m2, array_agg(cid order by a desc) as control_plot_ids
  from (
    select c.plot_id as cid,
           st_area(st_collectionextract(st_intersection(t.geom, c.geom), 3)::geography) as a
    from seoni.control_plots c
    where st_intersects(t.geom, c.geom)
  ) x
  where a > 0
) o on true;
create unique index if not exists mv_treatment_plot_checks_pk on seoni.mv_treatment_plot_checks (plot_id);

-- Treatment samples: inside their own plot? inside any control plot?
create materialized view if not exists seoni.mv_treatment_sample_checks as
select
  s.plot_id,
  coalesce(st_covers(t.geom, s.pre_geom), false)                        as pre_in_own_plot,
  round(st_distance(s.pre_geom::geography, t.geom::geography)::numeric, 1) as pre_dist_to_own_plot_m,
  (select array_agg(t2.plot_id) from seoni.treatment_plots t2 where st_covers(t2.geom, s.pre_geom)) as pre_in_treatment_plot_ids,
  (select array_agg(c.plot_id)  from seoni.control_plots c    where st_covers(c.geom, s.pre_geom))  as pre_in_control_plot_ids,
  coalesce(st_covers(t.geom, s.eoy_geom), false)                        as eoy_in_own_plot,
  round(st_distance(s.eoy_geom::geography, t.geom::geography)::numeric, 1) as eoy_dist_to_own_plot_m,
  (select array_agg(t2.plot_id) from seoni.treatment_plots t2 where st_covers(t2.geom, s.eoy_geom)) as eoy_in_treatment_plot_ids,
  (select array_agg(c.plot_id)  from seoni.control_plots c    where st_covers(c.geom, s.eoy_geom))  as eoy_in_control_plot_ids,
  round(st_distance(s.pre_geom::geography, s.eoy_geom::geography)::numeric, 1) as pre_eoy_distance_m
from seoni.treatment_samples s
left join seoni.treatment_plots t on t.plot_id = s.plot_id;
create unique index if not exists mv_treatment_sample_checks_pk on seoni.mv_treatment_sample_checks (plot_id);

-- Control plot vs treatment plots / treatment samples
create materialized view if not exists seoni.mv_control_plot_checks as
select
  c.plot_id,
  c.farmer_id,
  coalesce(cs.village_name,
           (select tp.village_name from seoni.treatment_plots tp
             where tp.farmer_id = c.farmer_id
             group by tp.village_name order by count(*) desc limit 1))  as village_name,
  coalesce(cs.farmer_name,
           (select s.farmer_name from seoni.treatment_samples s
             where s.farmer_id = c.farmer_id limit 1))                  as farmer_name,
  round(st_area(c.geom::geography)::numeric, 1)                         as plot_area_m2,
  exists (select 1 from seoni.treatment_plots t where t.plot_id = c.plot_id) as plot_id_in_treatment,
  coalesce(o.n, 0)::int                                                 as overlapping_treatment_count,
  coalesce(o.same_farmer_n, 0)::int                                     as overlapping_same_farmer_count,
  round(coalesce(o.overlap_m2, 0)::numeric, 2)                          as treatment_overlap_m2,
  case when st_area(c.geom::geography) > 0
       then round((coalesce(o.overlap_m2, 0) / st_area(c.geom::geography) * 100)::numeric, 2)
       else 0 end                                                       as treatment_overlap_pct,
  round(coalesce(o.max_single_pct, 0)::numeric, 2)                      as max_single_overlap_pct,
  o.treatment_plot_ids,
  coalesce(ts.n, 0)::int                                                as treatment_samples_inside
from seoni.control_plots c
left join seoni.control_samples cs on cs.control_plot_id = c.plot_id
left join lateral (
  select count(*)                                        as n,
         count(*) filter (where same_farmer)             as same_farmer_n,
         sum(a)                                          as overlap_m2,
         -- overlap as % of the smaller of the two plots: ~100 means "same field"
         max(a / nullif(least(area_c, area_t), 0) * 100) as max_single_pct,
         array_agg(tid order by a desc)                  as treatment_plot_ids
  from (
    select t.plot_id as tid,
           t.farmer_id = c.farmer_id as same_farmer,
           st_area(st_collectionextract(st_intersection(c.geom, t.geom), 3)::geography) as a,
           st_area(c.geom::geography) as area_c,
           st_area(t.geom::geography) as area_t
    from seoni.treatment_plots t
    where st_intersects(c.geom, t.geom)
  ) x
  where a > 0
) o on true
left join lateral (
  select count(*) as n
  from seoni.treatment_samples s
  where st_covers(c.geom, s.pre_geom) or st_covers(c.geom, s.eoy_geom)
) ts on true;
create unique index if not exists mv_control_plot_checks_pk on seoni.mv_control_plot_checks (plot_id);

-- Control samples: inside their own control plot? inside any treatment plot?
create materialized view if not exists seoni.mv_control_sample_checks as
select
  cs.control_plot_id,
  coalesce(st_covers(c.geom, cs.pre_geom), false)                       as pre_in_own_control,
  round(st_distance(cs.pre_geom::geography, c.geom::geography)::numeric, 1) as pre_dist_to_own_control_m,
  (select array_agg(t.plot_id) from seoni.treatment_plots t where st_covers(t.geom, cs.pre_geom)) as pre_in_treatment_plot_ids,
  coalesce(st_covers(c.geom, cs.eoy_geom), false)                       as eoy_in_own_control,
  round(st_distance(cs.eoy_geom::geography, c.geom::geography)::numeric, 1) as eoy_dist_to_own_control_m,
  (select array_agg(t.plot_id) from seoni.treatment_plots t where st_covers(t.geom, cs.eoy_geom)) as eoy_in_treatment_plot_ids
from seoni.control_samples cs
left join seoni.control_plots c on c.plot_id = cs.control_plot_id;
create unique index if not exists mv_control_sample_checks_pk on seoni.mv_control_sample_checks (control_plot_id);

create or replace function seoni.refresh_checks() returns json
language plpgsql security definer set search_path = seoni, public, extensions as $$
begin
  refresh materialized view seoni.mv_treatment_plot_checks;
  refresh materialized view seoni.mv_treatment_sample_checks;
  refresh materialized view seoni.mv_control_plot_checks;
  refresh materialized view seoni.mv_control_sample_checks;
  return json_build_object(
    'treatment_plots',   (select count(*) from seoni.mv_treatment_plot_checks),
    'treatment_samples', (select count(*) from seoni.mv_treatment_sample_checks),
    'control_plots',     (select count(*) from seoni.mv_control_plot_checks),
    'control_samples',   (select count(*) from seoni.mv_control_sample_checks));
end $$;

-- ---------------------------------------------------------------------
-- Review queue: one row per sampled treatment plot (with the farmer's
-- control plot), plus one row per sampled control plot whose farmer has
-- no sampled treatment plot.
-- ---------------------------------------------------------------------
create or replace view seoni.v_review_queue with (security_invoker = true) as
with units as (
  select 'T:' || s.plot_id                        as unit_id,
         s.plot_id                                as treatment_plot_id,
         (select c.plot_id from seoni.control_plots c
           where c.farmer_id = t.farmer_id order by c.plot_id limit 1) as control_plot_id,
         t.farmer_id,
         s.farmer_name,
         coalesce(s.village_name, t.village_name) as village_name
  from seoni.treatment_samples s
  join seoni.treatment_plots t on t.plot_id = s.plot_id
  union all
  select 'C:' || c.plot_id, null, c.plot_id, c.farmer_id, k.farmer_name, k.village_name
  from seoni.control_plots c
  join seoni.mv_control_plot_checks k on k.plot_id = c.plot_id
  where exists (select 1 from seoni.control_samples cs where cs.control_plot_id = c.plot_id)
    and not exists (select 1 from seoni.treatment_samples s
                      join seoni.treatment_plots t on t.plot_id = s.plot_id
                     where t.farmer_id = c.farmer_id)
)
select
  u.*,
  s.pre      as treatment_pre,
  s.eoy      as treatment_eoy,
  cs.pre_ids as control_pre,
  cs.eoy_ids as control_eoy,
  -- spatial facts behind the suggestions
  tsc.pre_in_own_plot                       as ts_pre_in_own_plot,
  tsc.eoy_in_own_plot                       as ts_eoy_in_own_plot,
  tsc.pre_in_control_plot_ids is not null   as ts_pre_in_control,
  tsc.eoy_in_control_plot_ids is not null   as ts_eoy_in_control,
  csc.pre_in_own_control                    as cs_pre_in_own_control,
  csc.eoy_in_own_control                    as cs_eoy_in_own_control,
  csc.pre_in_treatment_plot_ids is not null as cs_pre_in_treatment,
  csc.eoy_in_treatment_plot_ids is not null as cs_eoy_in_treatment,
  -- answers (stored on the sample rows)
  s.pre_sample_valid  as treatment_pre_valid,
  s.eoy_sample_valid  as treatment_eoy_valid,
  s.snake_visible     as treatment_snake_visible,
  cs.pre_sample_valid as control_pre_valid,
  cs.eoy_sample_valid as control_eoy_valid,
  cs.snake_visible    as control_snake_visible,
  -- status per sample row: na | pending | partial | done
  case when s.plot_id is null then 'na'
       when num_nonnulls(s.pre_sample_valid, s.eoy_sample_valid, s.snake_visible) = 0 then 'pending'
       when num_nonnulls(s.pre_sample_valid, s.eoy_sample_valid, s.snake_visible) = 3 then 'done'
       else 'partial' end as ts_status,
  case when cs.control_plot_id is null then 'na'
       when num_nonnulls(cs.pre_sample_valid, cs.eoy_sample_valid, cs.snake_visible) = 0 then 'pending'
       when num_nonnulls(cs.pre_sample_valid, cs.eoy_sample_valid, cs.snake_visible) = 3 then 'done'
       else 'partial' end as cs_status,
  coalesce('no' = any (array[s.pre_sample_valid, s.eoy_sample_valid,
                             cs.pre_sample_valid, cs.eoy_sample_valid]), false) as has_no_answer
from units u
left join seoni.treatment_samples          s   on s.plot_id = u.treatment_plot_id
left join seoni.control_samples            cs  on cs.control_plot_id = u.control_plot_id
left join seoni.mv_treatment_sample_checks tsc on tsc.plot_id = u.treatment_plot_id
left join seoni.mv_control_sample_checks   csc on csc.control_plot_id = u.control_plot_id;

-- One row per physical sample (treatment pre / EOY, control pre / EOY)
create or replace view seoni.v_samples with (security_invoker = true) as
select 'treatment'::text as kind, x.sample, s.plot_id as record_id, x.code,
       coalesce(s.village_name, t.village_name) as village_name, x.valid
from seoni.treatment_samples s
join seoni.treatment_plots t on t.plot_id = s.plot_id
cross join lateral (values ('pre', s.pre, s.pre_sample_valid),
                           ('eoy', s.eoy, s.eoy_sample_valid)) as x (sample, code, valid)
where x.code is not null
union all
select 'control', x.sample, s.control_plot_id, x.code, k.village_name, x.valid
from seoni.control_samples s
left join seoni.mv_control_plot_checks k on k.plot_id = s.control_plot_id
cross join lateral (values ('pre', s.pre_ids, s.pre_sample_valid),
                           ('eoy', s.eoy_ids, s.eoy_sample_valid)) as x (sample, code, valid)
where x.code is not null;

-- ---------------------------------------------------------------------
-- Functions the web page calls
-- ---------------------------------------------------------------------

-- Village picker: counts + extent per village
create or replace function seoni.get_villages() returns json
language sql stable security invoker set search_path = seoni, public, extensions as $$
  select coalesce(json_agg(json_build_object(
           'village_name', x.v, 'plots', x.n,
           'sampled', (select count(*) from seoni.treatment_samples s
                         join seoni.treatment_plots t on t.plot_id = s.plot_id
                        where coalesce(s.village_name, t.village_name) = x.v),
           'controls', (select count(*) from seoni.mv_control_plot_checks k where k.village_name = x.v),
           'pending_samples', (select count(*) from seoni.v_samples vs where vs.village_name = x.v and vs.valid is null),
           'bbox', json_build_array(st_xmin(x.e), st_ymin(x.e), st_xmax(x.e), st_ymax(x.e))) order by x.v), '[]'::json)
  from (select village_name as v, count(*) as n, st_extent(geom) as e
          from seoni.treatment_plots where village_name is not null group by village_name) x
$$;

-- Samples pending / valid / invalid per kind (treatment / control) and sample (pre / eoy).
-- p_villages null = all villages.
create or replace function seoni.get_sample_progress(p_villages text[] default null) returns json
language sql stable security invoker set search_path = seoni, public as $$
  select coalesce(json_agg(json_build_object(
           'kind', kind, 'sample', sample, 'total', total,
           'pending', pending, 'valid', valid, 'invalid', invalid) order by kind desc, sample desc), '[]'::json)
  from (
    select kind, sample,
           count(*)                              as total,
           count(*) filter (where valid is null) as pending,
           count(*) filter (where valid = 'yes') as valid,
           count(*) filter (where valid = 'no')  as invalid
    from seoni.v_samples
    where p_villages is null or village_name = any (p_villages)
    group by kind, sample
  ) x
$$;

-- Control plots, sampled treatment plots and sample points for the chosen villages
create or replace function seoni.get_static_layers(p_villages text[]) returns json
language sql stable security invoker set search_path = seoni, public, extensions as $$
  select json_build_object(
    'control_plots', (
      select coalesce(json_agg(json_build_object(
        'type', 'Feature',
        'geometry', st_asgeojson(c.geom, 7)::json,
        'properties', json_build_object(
          'plot_id', c.plot_id, 'farmer_id', c.farmer_id,
          'farmer_name', k.farmer_name, 'village_name', k.village_name,
          'conflict', coalesce(k.treatment_overlap_m2, 0) > 0 or coalesce(k.plot_id_in_treatment, false)))), '[]'::json)
      from seoni.control_plots c
      join seoni.mv_control_plot_checks k on k.plot_id = c.plot_id
      where c.geom is not null and k.village_name = any (p_villages)),
    'sampled_treatment_plots', (
      select coalesce(json_agg(json_build_object(
        'type', 'Feature',
        'geometry', st_asgeojson(t.geom, 7)::json,
        'properties', json_build_object(
          'plot_id', t.plot_id, 'farmer_id', t.farmer_id, 'farmer_name', s.farmer_name,
          'village_name', coalesce(s.village_name, t.village_name), 'crusher_code', t.crusher_code, 'has_samples', true,
          'conflict', coalesce(k.control_overlap_m2, 0) > 0))), '[]'::json)
      from seoni.treatment_samples s
      join seoni.treatment_plots t on t.plot_id = s.plot_id
      left join seoni.mv_treatment_plot_checks k on k.plot_id = t.plot_id
      where t.geom is not null and coalesce(s.village_name, t.village_name) = any (p_villages)),
    'treatment_samples', (
      select coalesce(json_agg(json_build_object(
        'plot_id', s.plot_id, 'farmer_name', s.farmer_name, 'village_name', coalesce(s.village_name, t.village_name),
        'pre', s.pre, 'pre_lng', st_x(s.pre_geom), 'pre_lat', st_y(s.pre_geom),
        'eoy', s.eoy, 'eoy_lng', st_x(s.eoy_geom), 'eoy_lat', st_y(s.eoy_geom))), '[]'::json)
      from seoni.treatment_samples s
      join seoni.treatment_plots t on t.plot_id = s.plot_id
      where coalesce(s.village_name, t.village_name) = any (p_villages)),
    'control_samples', (
      select coalesce(json_agg(json_build_object(
        'control_plot_id', s.control_plot_id, 'farmer_name', s.farmer_name, 'village_name', k.village_name,
        'pre', s.pre_ids, 'pre_lng', st_x(s.pre_geom), 'pre_lat', st_y(s.pre_geom),
        'eoy', s.eoy_ids, 'eoy_lng', st_x(s.eoy_geom), 'eoy_lat', st_y(s.eoy_geom))), '[]'::json)
      from seoni.control_samples s
      join seoni.mv_control_plot_checks k on k.plot_id = s.control_plot_id
      where k.village_name = any (p_villages))
  )
$$;

-- Every deployment plot in the chosen villages (largest village ≈ 2.1k plots)
create or replace function seoni.get_village_plots(p_villages text[], max_features int default 15000)
returns json
language sql stable security invoker set search_path = seoni, public, extensions as $$
  select coalesce(json_agg(f), '[]'::json) from (
    select json_build_object(
      'type', 'Feature',
      'geometry', st_asgeojson(t.geom, 7)::json,
      'properties', json_build_object(
        'plot_id', t.plot_id, 'farmer_id', t.farmer_id, 'village_name', t.village_name,
        'crusher_code', t.crusher_code,
        'has_samples', coalesce(k.has_samples, false),
        'conflict', coalesce(k.control_overlap_m2, 0) > 0)) as f
    from seoni.treatment_plots t
    left join seoni.mv_treatment_plot_checks k on k.plot_id = t.plot_id
    where t.geom is not null and t.village_name = any (p_villages)
    limit greatest(1, least(max_features, 20000))
  ) q
$$;

-- Everything the review panel needs for one farmer, in one call.
-- Pass a treatment plot id, a control plot id, or both; the other side
-- is found through farmer_id.
create or replace function seoni.get_unit(p_treatment_plot_id text default null,
                                          p_control_plot_id   text default null)
returns json
language plpgsql stable security invoker set search_path = seoni, public, extensions as $$
declare
  v_tp     text := nullif(btrim(p_treatment_plot_id), '');
  v_cp     text := nullif(btrim(p_control_plot_id), '');
  v_farmer text;
begin
  if v_tp is not null then
    select farmer_id into v_farmer from seoni.treatment_plots where plot_id = v_tp;
    if not found then v_tp := null; end if;
  end if;

  if v_cp is not null then
    if v_farmer is null then
      select farmer_id into v_farmer from seoni.control_plots where plot_id = v_cp;
    end if;
    if not exists (select 1 from seoni.control_plots where plot_id = v_cp) then v_cp := null; end if;
  elsif v_farmer is not null then
    select plot_id into v_cp from seoni.control_plots where farmer_id = v_farmer order by plot_id limit 1;
  end if;

  if v_tp is null and v_cp is not null then
    select s.plot_id into v_tp
      from seoni.treatment_samples s join seoni.treatment_plots t on t.plot_id = s.plot_id
     where t.farmer_id = v_farmer order by s.plot_id limit 1;
  end if;

  if v_tp is null and v_cp is null then
    return null;
  end if;

  return json_build_object(
    'farmer_id', v_farmer,
    'farmer_name', coalesce(
        (select s.farmer_name from seoni.treatment_samples s
           join seoni.treatment_plots t on t.plot_id = s.plot_id
          where t.farmer_id = v_farmer limit 1),
        (select farmer_name from seoni.control_samples where control_plot_id = v_cp)),
    'treatment_plot', (
      select json_build_object(
        'row', to_jsonb(t) - 'geometry' - 'geom',
        'geometry', st_asgeojson(t.geom, 7)::json,
        'checks', to_jsonb(k))
      from seoni.treatment_plots t
      left join seoni.mv_treatment_plot_checks k on k.plot_id = t.plot_id
      where t.plot_id = v_tp),
    'treatment_sample', (
      select json_build_object(
        'row', to_jsonb(s) - 'pre_geom' - 'eoy_geom',
        'pre', json_build_array(st_x(s.pre_geom), st_y(s.pre_geom)),
        'eoy', json_build_array(st_x(s.eoy_geom), st_y(s.eoy_geom)),
        'checks', to_jsonb(k))
      from seoni.treatment_samples s
      left join seoni.mv_treatment_sample_checks k on k.plot_id = s.plot_id
      where s.plot_id = v_tp),
    'control_plot', (
      select json_build_object(
        'row', to_jsonb(c) - 'geometry' - 'geom',
        'geometry', st_asgeojson(c.geom, 7)::json,
        'checks', to_jsonb(k))
      from seoni.control_plots c
      left join seoni.mv_control_plot_checks k on k.plot_id = c.plot_id
      where c.plot_id = v_cp),
    'control_sample', (
      select json_build_object(
        'row', to_jsonb(s) - 'pre_geom' - 'eoy_geom',
        'pre', json_build_array(st_x(s.pre_geom), st_y(s.pre_geom)),
        'eoy', json_build_array(st_x(s.eoy_geom), st_y(s.eoy_geom)),
        'checks', to_jsonb(k))
      from seoni.control_samples s
      left join seoni.mv_control_sample_checks k on k.control_plot_id = s.control_plot_id
      where s.control_plot_id = v_cp),
    'farmer_treatment_plots', (
      select json_agg(json_build_object('plot_id', t.plot_id, 'has_samples', s.plot_id is not null)
                      order by s.plot_id is null, t.plot_id)
      from seoni.treatment_plots t
      left join seoni.treatment_samples s on s.plot_id = t.plot_id
      where t.farmer_id = v_farmer)
  );
end $$;

-- Save answers onto the sample rows. Each element is ONE answer:
--   { table: 'treatment_samples' | 'control_samples', id: <plot_id | control_plot_id>,
--     question: 'pre' | 'eoy' | 'snake', value: 'yes' | 'no' | null }
-- Only that one column changes; all elements commit together.
create or replace function seoni.save_answers(p jsonb) returns int
language plpgsql security invoker set search_path = seoni, public as $$
declare
  r   jsonb;
  t   text;
  q   text;
  v   text;
  n   int := 0;
  cnt int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  if jsonb_typeof(p) <> 'array' then
    raise exception 'Expected an array of answers';
  end if;

  for r in select * from jsonb_array_elements(p) loop
    t := r ->> 'table';
    q := r ->> 'question';
    v := nullif(r ->> 'value', '');
    if t not in ('treatment_samples', 'control_samples') or q not in ('pre', 'eoy', 'snake') then
      raise exception 'Unknown question: %', r;
    end if;
    if v is not null and v not in ('yes', 'no') then
      raise exception 'Answer must be yes or no: %', r;
    end if;

    execute format('update seoni.%I set %I = $1 where %I = $2',
                   t,
                   case q when 'snake' then 'snake_visible' else q || '_sample_valid' end,
                   case t when 'treatment_samples' then 'plot_id' else 'control_plot_id' end)
    using v, r ->> 'id';

    get diagnostics cnt = row_count;
    if cnt = 0 then
      raise exception '% % not found', t, r ->> 'id';
    end if;
    n := n + cnt;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Access: signed-in users only
-- ---------------------------------------------------------------------
grant select on seoni.mv_treatment_plot_checks, seoni.mv_treatment_sample_checks,
                seoni.mv_control_plot_checks, seoni.mv_control_sample_checks,
                seoni.v_review_queue, seoni.v_samples to authenticated, service_role;

revoke all on function seoni.refresh_checks() from public;
grant execute on function seoni.refresh_checks() to service_role;

revoke all on function seoni.get_villages(), seoni.get_sample_progress(text[]),
  seoni.get_static_layers(text[]), seoni.get_village_plots(text[], int),
  seoni.get_unit(text, text), seoni.save_answers(jsonb) from public;
grant execute on function seoni.get_villages(), seoni.get_sample_progress(text[]),
  seoni.get_static_layers(text[]), seoni.get_village_plots(text[], int),
  seoni.get_unit(text, text), seoni.save_answers(jsonb) to authenticated;

-- Build the checks from the imported data
select seoni.refresh_checks();
