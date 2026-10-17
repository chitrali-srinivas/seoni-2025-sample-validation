-- =====================================================================
-- Seoni K25 sample validation — STEP 3: two more snake columns
--
-- Adds to seoni.treatment_samples and seoni.control_samples:
--   snake_visible_google  is the snake pattern visible on Google Maps imagery?  (reviewer)
--   snake_ml_esri         snake pattern detected by the ML check on Esri imagery (automatic)
-- Only adds/replaces objects in schema "seoni"; never drops anything.
-- Safe to run more than once.
-- =====================================================================

set search_path = seoni, public, extensions;

alter table seoni.treatment_samples
  add column if not exists snake_visible_google text check (snake_visible_google in ('yes', 'no')),
  add column if not exists snake_ml_esri        text check (snake_ml_esri in ('yes', 'no'));
alter table seoni.control_samples
  add column if not exists snake_visible_google text check (snake_visible_google in ('yes', 'no')),
  add column if not exists snake_ml_esri        text check (snake_ml_esri in ('yes', 'no'));

grant update (snake_visible_google, snake_ml_esri)
  on seoni.treatment_samples, seoni.control_samples to authenticated;

-- Review queue: same columns as before, with the new answers appended and the
-- status now counting four reviewer answers (snake, snake on Google, pre, EOY).
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
  tsc.pre_in_own_plot                       as ts_pre_in_own_plot,
  tsc.eoy_in_own_plot                       as ts_eoy_in_own_plot,
  tsc.pre_in_control_plot_ids is not null   as ts_pre_in_control,
  tsc.eoy_in_control_plot_ids is not null   as ts_eoy_in_control,
  csc.pre_in_own_control                    as cs_pre_in_own_control,
  csc.eoy_in_own_control                    as cs_eoy_in_own_control,
  csc.pre_in_treatment_plot_ids is not null as cs_pre_in_treatment,
  csc.eoy_in_treatment_plot_ids is not null as cs_eoy_in_treatment,
  s.pre_sample_valid  as treatment_pre_valid,
  s.eoy_sample_valid  as treatment_eoy_valid,
  s.snake_visible     as treatment_snake_visible,
  cs.pre_sample_valid as control_pre_valid,
  cs.eoy_sample_valid as control_eoy_valid,
  cs.snake_visible    as control_snake_visible,
  case when s.plot_id is null then 'na'
       when num_nonnulls(s.pre_sample_valid, s.eoy_sample_valid, s.snake_visible, s.snake_visible_google) = 0 then 'pending'
       when num_nonnulls(s.pre_sample_valid, s.eoy_sample_valid, s.snake_visible, s.snake_visible_google) = 4 then 'done'
       else 'partial' end as ts_status,
  case when cs.control_plot_id is null then 'na'
       when num_nonnulls(cs.pre_sample_valid, cs.eoy_sample_valid, cs.snake_visible, cs.snake_visible_google) = 0 then 'pending'
       when num_nonnulls(cs.pre_sample_valid, cs.eoy_sample_valid, cs.snake_visible, cs.snake_visible_google) = 4 then 'done'
       else 'partial' end as cs_status,
  coalesce('no' = any (array[s.pre_sample_valid, s.eoy_sample_valid,
                             cs.pre_sample_valid, cs.eoy_sample_valid]), false) as has_no_answer,
  s.snake_visible_google  as treatment_snake_google,
  cs.snake_visible_google as control_snake_google,
  s.snake_ml_esri         as treatment_snake_ml_esri,
  cs.snake_ml_esri        as control_snake_ml_esri
from units u
left join seoni.treatment_samples          s   on s.plot_id = u.treatment_plot_id
left join seoni.control_samples            cs  on cs.control_plot_id = u.control_plot_id
left join seoni.mv_treatment_sample_checks tsc on tsc.plot_id = u.treatment_plot_id
left join seoni.mv_control_sample_checks   csc on csc.control_plot_id = u.control_plot_id;

grant select on seoni.v_review_queue to authenticated, service_role;

-- Save answers: now also accepts 'snake_google' and 'snake_ml_esri'
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
    if t not in ('treatment_samples', 'control_samples')
       or q not in ('pre', 'eoy', 'snake', 'snake_google', 'snake_ml_esri') then
      raise exception 'Unknown question: %', r;
    end if;
    if v is not null and v not in ('yes', 'no') then
      raise exception 'Answer must be yes or no: %', r;
    end if;

    execute format('update seoni.%I set %I = $1 where %I = $2',
                   t,
                   case q when 'snake'         then 'snake_visible'
                          when 'snake_google'  then 'snake_visible_google'
                          when 'snake_ml_esri' then 'snake_ml_esri'
                          else q || '_sample_valid' end,
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
