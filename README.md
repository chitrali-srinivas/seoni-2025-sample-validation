# Seoni K25 — sample validation

One map, all layers, one review form. For every sample row (treatment and control) reviewers answer three Yes/No questions:

| Question | Column on the sample row |
|----------|--------------------------|
| Is the snake pattern visible in the background (of that plot)? | `snake_visible` |
| Is the pre sample valid? | `pre_sample_valid` |
| Is the EOY sample valid? | `eoy_sample_valid` |

Only `seoni.treatment_samples` and `seoni.control_samples` get these columns (empty = not answered). Plot tables hold sheet data only. Everything lives in its own schema, `seoni`, so existing tables in the project are never touched, and the SQL never drops anything.

```
supabase/001_schema.sql            STEP 1 – schema "seoni" + the four tables
supabase/002_checks_and_api.sql    STEP 2 – spatial checks + functions the page calls
web/                               static HTML app (Google Maps + supabase-js)
scripts/load-data.mjs              optional CLI loader (alternative to the CSV import)
```

* Treatment plot ↔ treatment samples: `plot_id`
* Treatment plot ↔ control plot: `farmer_id`
* Control plot ↔ control samples: `control_plot_id`

The system suggests valid / invalid for each pre and EOY sample from where it was picked. A treatment sample outside its own plot or inside a control plot is suggested invalid; a control sample outside its own control plot or inside a treatment plot likewise. The snake question is a visual check, so it has no suggestion. The **Samples to verify** panel shows pending / valid / invalid counts per sample type for the loaded villages or for all villages.

## Supabase setup

1. **SQL editor → run `supabase/001_schema.sql`.** It creates schema `seoni` and the tables `treatment_plots`, `treatment_samples`, `control_plots` and `control_samples`. Their columns are named exactly like your CSV headers.
2. **Import the CSVs unchanged** (Table Editor → schema `seoni` → table → Insert → *Import data from CSV*), plots before their samples:
   | CSV | table |
   |-----|-------|
   | `Seoni Sample plots - Deployment.csv` | `treatment_plots` |
   | `Seoni Sample plots - Deployment_Samples+plots.csv` | `treatment_samples` |
   | `Seoni Sample plots - control_plot.csv` | `control_plots` |
   | `Seoni Sample plots - Control_sampled_Plots.csv` | `control_samples` |

   Map shapes are filled in automatically on import. Unclosed polygon rings in the sheets are closed by the database.
3. **SQL editor → run `supabase/002_checks_and_api.sql`.** It builds the spatial checks from the imported rows. If you re-import later, run `select seoni.refresh_checks();`.
4. **Project Settings → Data API → Exposed schemas → add `seoni`.** The page reaches the tables through the API.
5. **Authentication:** turn off public sign-ups and add each reviewer under Users → *Add user*. Only signed-in users can read data, and they can change only the three answer columns.
6. **`web/config.js`:** fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `GOOGLE_MAPS_API_KEY`. `SUPABASE_SCHEMA` defaults to `seoni`.

## Publishing (GitHub Pages)

The page is served from the `gh-pages` branch, which holds the contents of `web/`. Repo **Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**. After changing anything in `web/`, commit it and run:

```bash
git push origin main && git subtree push --prefix web origin gh-pages
```

The local demo data (`web/demo/*.json`, `web/demo/villages/`) is git-ignored and never published. `web/config.js` is published: it holds the Supabase URL, the anon key and the Maps key, all meant to be visible in a browser. Restrict the Maps key to `https://chitrali-srinivas.github.io/*`.

## Local demo (no Supabase needed)

```bash
cd web && python3 -m http.server 5173
```

Open http://localhost:5173. Until `web/config.js` has a real Supabase URL, the page runs on `web/demo/demo-backend.js`: it reads `web/demo/demo-data.json` plus one `web/demo/villages/<village>.json` per loaded village (built from the four CSVs) and saves answers in that browser's localStorage (same three columns as Supabase). A **DEMO** badge shows in the header. Without a Google Maps key, the map loads in Google's "for development purposes only" mode (watermarked, with a warning dialog). Plots that have no samples show no system checks in demo mode. Add `?demo` to the URL to force demo mode after Supabase is configured.

## Using it

* **Villages first**: nothing is loaded until villages are picked (*Select villages* in the top bar, or click a village marker on the map). Only those villages' plots, samples, control plots and queue are fetched; the choice is remembered in the browser. The total is capped at `MAX_PLOTS_LOADED` (default 8,000; the largest village has ~2,100 plots). Opening a plot by id from another village adds that village automatically.
* **Layers** (left): deployment plots of the loaded villages are drawn from zoom 13 (`ALL_PLOTS_MIN_ZOOM`); sampled treatment plots, control plots and the four sample layers are always drawn. Overlapping plots are outlined in red. "Colour plots by → Review" colours plots pending / partial / done / invalid.
* **Filters**: free-text search (farmer, plot id, sample code; press Enter on a numeric id to open any plot), review status (pending / partial / done / invalid), and "system suggests invalid" / clean. The status and suggestion filters also hide non-matching plots and samples on the map.
* **Form** (right): plot context at the top, then for each sample row the snake question and a Yes/No per sample, with the system suggestion and its reason. *Fill unanswered with system suggestions* only fills blanks. Click an active answer again to clear it. ⌘/Ctrl+S saves. *Save & next* moves through the filtered queue.
* **Colour by → Review**: sample points turn green (valid), red (invalid) or grey (not answered).
* **Export** (top right): the treatment and control sample sheets in their original column order, with the answer columns appended. Also available: one row per sample, or the review queue.

## What the checks found on the current sheets

* 84 / 131 control plots touch a treatment plot; 60 by more than 1 m², 22 by more than 5 %, and 7 share ≥ 50 % with one treatment plot (likely the same field).
* 6 treatment samples (pre and EOY) lie outside their own plot (most by tens of metres). None lie in a control plot.
* 4 control samples fall inside treatment plots; 1 control EOY sample is outside its control plot.
* 1 deployment row (`7041286`) has no geometry. It is loaded but not drawn.
* 124 deployment polygons and 97 control polygons have unclosed rings (last point ≠ first). The loader closes them before upload, and the app closes any it receives before drawing.
