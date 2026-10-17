-- =====================================================================
-- Seoni K25 sample validation — STEP 1: create tables
--
-- Everything is created in a new schema "seoni". Nothing in your existing
-- schemas is changed, and this script never drops anything.
--
-- After running it, import the four CSVs unchanged into the seoni schema
-- (Table Editor → schema "seoni" → table → Insert → Import data from CSV),
-- plots before their samples:
--     Deployment.csv               → seoni.treatment_plots
--     Deployment_Samples+plots.csv → seoni.treatment_samples
--     control_plot.csv             → seoni.control_plots
--     Control_sampled_Plots.csv    → seoni.control_samples
-- then run 002_checks_and_api.sql and 003_snake_google_and_ml.sql.
--
-- Columns that collect reviewer answers (only on the two sample tables):
--     pre_sample_valid   is the pre sample valid?                       yes / no
--     eoy_sample_valid   is the EOY sample valid?                       yes / no
--     snake_visible      is the snake pattern visible in the background? yes / no
--     snake_visible_google  is the snake pattern visible on Google Maps?  yes / no
--     snake_ml_esri      snake detected by the ML check on Esri imagery   yes / no (automatic)
-- (empty = not answered yet)
-- =====================================================================

create extension if not exists postgis with schema extensions;
create schema if not exists seoni;
set search_path = seoni, public, extensions;

-- ---------------------------------------------------------------------
-- Geometry helpers (used to turn the sheet's text into map shapes)
-- ---------------------------------------------------------------------

-- "lat,lng" text -> Point(lng lat), SRID 4326
create or replace function seoni.latlon_to_point(t text)
returns geometry
language sql immutable
set search_path = seoni, public, extensions
as $$
  select case
    when t is null or btrim(t) = '' or position(',' in t) = 0 then null
    else st_setsrid(st_makepoint(btrim(split_part(t, ',', 2))::float8,
                                 btrim(split_part(t, ',', 1))::float8), 4326)
  end
$$;

-- Some sheet polygons end without repeating their first point; close every ring
create or replace function seoni.close_geojson_rings(g jsonb)
returns jsonb
language sql immutable
as $$
  select case g ->> 'type'
    when 'Polygon' then jsonb_set(g, '{coordinates}', (
      select jsonb_agg(case when r -> 0 = r -> -1 then r else r || jsonb_build_array(r -> 0) end order by i)
      from jsonb_array_elements(g -> 'coordinates') with ordinality as x (r, i)))
    when 'MultiPolygon' then jsonb_set(g, '{coordinates}', (
      select jsonb_agg((
        select jsonb_agg(case when r -> 0 = r -> -1 then r else r || jsonb_build_array(r -> 0) end order by j)
        from jsonb_array_elements(p) with ordinality as y (r, j)) order by i)
      from jsonb_array_elements(g -> 'coordinates') with ordinality as x (p, i)))
    else g
  end
$$;

-- GeoJSON text -> valid (multi)polygon, SRID 4326
create or replace function seoni.geojson_to_polygon(t text)
returns geometry
language sql immutable
set search_path = seoni, public, extensions
as $$
  select case
    when t is null or btrim(t) = '' then null
    else st_collectionextract(st_makevalid(st_setsrid(
           st_geomfromgeojson(seoni.close_geojson_rings(t::jsonb)::text), 4326)), 3)
  end
$$;

-- ---------------------------------------------------------------------
-- Tables: sheet columns with the same names and order as the CSV headers,
-- then a derived geometry column (filled automatically on import).
-- ---------------------------------------------------------------------

-- Deployment.csv
create table if not exists seoni.treatment_plots (
  deployment_id  text,
  plot_id        text primary key,
  village_name   text,
  farmer_id      text,
  crusher_code   text,
  deployment_ids text,
  n_deployments  integer,
  area           numeric,
  tonnage        numeric,
  geometry       text,
  geom           geometry(Geometry, 4326)
);
create index if not exists treatment_plots_geom_idx    on seoni.treatment_plots using gist (geom);
create index if not exists treatment_plots_farmer_idx  on seoni.treatment_plots (farmer_id);
create index if not exists treatment_plots_village_idx on seoni.treatment_plots (village_name);

-- Deployment_Samples+plots.csv
create table if not exists seoni.treatment_samples (
  deployment_id    text,
  plot_id          text primary key references seoni.treatment_plots (plot_id),
  village_name     text,
  farmer_id        text,
  farmer_name      text,
  crusher_code     text,
  deployment_ids   text,
  n_deployments    integer,
  pre              text,
  pre_location     text,
  eoy              text,
  eoy_location     text,
  pre_geom         geometry(Point, 4326),
  eoy_geom         geometry(Point, 4326),
  pre_sample_valid text check (pre_sample_valid in ('yes', 'no')),
  eoy_sample_valid text check (eoy_sample_valid in ('yes', 'no')),
  snake_visible    text check (snake_visible in ('yes', 'no')),
  snake_visible_google text check (snake_visible_google in ('yes', 'no')),
  snake_ml_esri    text check (snake_ml_esri in ('yes', 'no'))
);
create index if not exists treatment_samples_pre_idx    on seoni.treatment_samples using gist (pre_geom);
create index if not exists treatment_samples_eoy_idx    on seoni.treatment_samples using gist (eoy_geom);
create index if not exists treatment_samples_farmer_idx on seoni.treatment_samples (farmer_id);

-- control_plot.csv (capitalised headers kept so the CSV imports unchanged)
create table if not exists seoni.control_plots (
  farmer_id            text,
  "Base"               text,
  "Base_Season_Year"   text,
  village_id           text,
  base_id              text,
  az_id                text,
  control_plot_terrain text,
  control_area         numeric,
  plot_id              text primary key,
  geometry             text,
  surveyor_name        text,
  location             text,
  calculated_area      numeric,
  "Season"             text,
  "Year"               integer,
  geom                 geometry(Geometry, 4326)
);
create index if not exists control_plots_geom_idx   on seoni.control_plots using gist (geom);
create index if not exists control_plots_farmer_idx on seoni.control_plots (farmer_id);

-- Control_sampled_Plots.csv
create table if not exists seoni.control_samples (
  deployment_id        text,
  control_plot_id      text primary key references seoni.control_plots (plot_id),
  village_name         text,
  farmer_name          text,
  pre_ids              text,
  eoy_ids              text,
  control_pre_location text,
  control_eoy_location text,
  pre_geom             geometry(Point, 4326),
  eoy_geom             geometry(Point, 4326),
  pre_sample_valid     text check (pre_sample_valid in ('yes', 'no')),
  eoy_sample_valid     text check (eoy_sample_valid in ('yes', 'no')),
  snake_visible        text check (snake_visible in ('yes', 'no')),
  snake_visible_google text check (snake_visible_google in ('yes', 'no')),
  snake_ml_esri        text check (snake_ml_esri in ('yes', 'no'))
);
create index if not exists control_samples_pre_idx on seoni.control_samples using gist (pre_geom);
create index if not exists control_samples_eoy_idx on seoni.control_samples using gist (eoy_geom);

-- ---------------------------------------------------------------------
-- Fill the geometry columns from the sheet values on import
-- (saving an answer doesn't touch them)
-- ---------------------------------------------------------------------
create or replace function seoni.tg_plot_geom() returns trigger
language plpgsql set search_path = seoni, public, extensions as $$
begin
  new.geom := seoni.geojson_to_polygon(new.geometry);
  return new;
end $$;

create or replace function seoni.tg_treatment_sample_geom() returns trigger
language plpgsql set search_path = seoni, public, extensions as $$
begin
  new.pre_geom := seoni.latlon_to_point(new.pre_location);
  new.eoy_geom := seoni.latlon_to_point(new.eoy_location);
  return new;
end $$;

create or replace function seoni.tg_control_sample_geom() returns trigger
language plpgsql set search_path = seoni, public, extensions as $$
begin
  new.pre_geom := seoni.latlon_to_point(new.control_pre_location);
  new.eoy_geom := seoni.latlon_to_point(new.control_eoy_location);
  return new;
end $$;

create or replace trigger trg_geom before insert or update of geometry on seoni.treatment_plots
  for each row execute function seoni.tg_plot_geom();
create or replace trigger trg_geom before insert or update of geometry on seoni.control_plots
  for each row execute function seoni.tg_plot_geom();
create or replace trigger trg_geom before insert or update of pre_location, eoy_location on seoni.treatment_samples
  for each row execute function seoni.tg_treatment_sample_geom();
create or replace trigger trg_geom before insert or update of control_pre_location, control_eoy_location on seoni.control_samples
  for each row execute function seoni.tg_control_sample_geom();

-- ---------------------------------------------------------------------
-- Access: signed-in reviewers can read everything and can change only the
-- answer columns on the sample tables. Not reachable without sign-in.
-- (Dashboard imports and the service-role key are not limited by this.)
-- ---------------------------------------------------------------------
grant usage on schema seoni to authenticated, service_role;
grant select on seoni.treatment_plots, seoni.treatment_samples,
                seoni.control_plots, seoni.control_samples to authenticated;
grant all on seoni.treatment_plots, seoni.treatment_samples,
             seoni.control_plots, seoni.control_samples to service_role;
grant update (pre_sample_valid, eoy_sample_valid, snake_visible, snake_visible_google, snake_ml_esri)
  on seoni.treatment_samples, seoni.control_samples to authenticated;

alter table seoni.treatment_plots   enable row level security;
alter table seoni.treatment_samples enable row level security;
alter table seoni.control_plots     enable row level security;
alter table seoni.control_samples   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['treatment_plots', 'treatment_samples', 'control_plots', 'control_samples'] loop
    if not exists (select 1 from pg_policies where schemaname = 'seoni' and tablename = t and policyname = 'reviewers read') then
      execute format('create policy "reviewers read" on seoni.%I for select to authenticated using (true)', t);
    end if;
  end loop;
  foreach t in array array['treatment_samples', 'control_samples'] loop
    if not exists (select 1 from pg_policies where schemaname = 'seoni' and tablename = t and policyname = 'reviewers answer') then
      execute format('create policy "reviewers answer" on seoni.%I for update to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;
