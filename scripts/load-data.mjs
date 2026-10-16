#!/usr/bin/env node
// Load the four Seoni sheets (CSV exports) into the Supabase "seoni" schema, then refresh
// the rule checks. (Alternative to importing the CSVs in the Supabase Table Editor.)
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role / secret key> \
//   node scripts/load-data.mjs --dir ~/Downloads
//
// Options
//   --dir <folder>               folder holding the four CSVs (default ~/Downloads)
//   --treatment-plots <file>     override individual file paths
//   --treatment-samples <file>
//   --control-plots <file>
//   --control-samples <file>
//   --dry-run                    parse + validate only, upload nothing
//
// Re-running is safe: rows are upserted on their primary key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
const DIR = expandHome(args.dir || '~/Downloads');
const BATCH = 500;
const CONCURRENCY = 4;
const closedRings = []; // set by closedGeojson() for the row being prepared

const SHEETS = [
  {
    table: 'treatment_plots',
    key: 'plot_id',
    file: args['treatment-plots'] || 'Seoni Sample plots - Deployment.csv',
    required: ['plot_id', 'farmer_id', 'geometry'],
    row: (r) => ({
      plot_id: str(r.plot_id),
      deployment_id: str(r.deployment_id),
      village_name: str(r.village_name),
      farmer_id: str(r.farmer_id),
      crusher_code: str(r.crusher_code),
      deployment_ids: str(r.deployment_ids),
      n_deployments: int(r.n_deployments),
      area: num(r.area),
      tonnage: num(r.tonnage),
      geometry: closedGeojson(r.geometry),
    }),
  },
  {
    table: 'treatment_samples',
    key: 'plot_id',
    file: args['treatment-samples'] || 'Seoni Sample plots - Deployment_Samples+plots.csv',
    required: ['plot_id', 'pre', 'pre_location', 'eoy', 'eoy_location'],
    parent: { table: 'treatment_plots', field: 'plot_id' },
    row: (r) => ({
      plot_id: str(r.plot_id),
      deployment_id: str(r.deployment_id),
      village_name: str(r.village_name),
      farmer_id: str(r.farmer_id),
      farmer_name: str(r.farmer_name),
      crusher_code: str(r.crusher_code),
      deployment_ids: str(r.deployment_ids),
      n_deployments: int(r.n_deployments),
      pre: str(r.pre),
      pre_location: str(r.pre_location),
      eoy: str(r.eoy),
      eoy_location: str(r.eoy_location),
    }),
  },
  {
    table: 'control_plots',
    key: 'plot_id',
    file: args['control-plots'] || 'Seoni Sample plots - control_plot.csv',
    required: ['plot_id', 'farmer_id', 'geometry'],
    row: (r) => ({
      plot_id: str(r.plot_id),
      farmer_id: str(r.farmer_id),
      Base: str(r.Base),
      Base_Season_Year: str(r.Base_Season_Year),
      village_id: str(r.village_id),
      base_id: str(r.base_id),
      az_id: str(r.az_id),
      control_plot_terrain: str(r.control_plot_terrain),
      control_area: num(r.control_area),
      surveyor_name: str(r.surveyor_name),
      location: str(r.location),
      calculated_area: num(r.calculated_area),
      Season: str(r.Season),
      Year: int(r.Year),
      geometry: closedGeojson(r.geometry),
    }),
  },
  {
    table: 'control_samples',
    key: 'control_plot_id',
    file: args['control-samples'] || 'Seoni Sample plots - Control_sampled_Plots.csv',
    required: ['control_plot_id', 'pre_ids', 'control_pre_location', 'eoy_ids', 'control_eoy_location'],
    parent: { table: 'control_plots', field: 'control_plot_id' },
    row: (r) => ({
      control_plot_id: str(r.control_plot_id),
      deployment_id: str(r.deployment_id),
      village_name: str(r.village_name),
      farmer_name: str(r.farmer_name),
      pre_ids: str(r.pre_ids),
      eoy_ids: str(r.eoy_ids),
      control_pre_location: str(r.control_pre_location),
      control_eoy_location: str(r.control_eoy_location),
    }),
  },
];

main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});

async function main() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!DRY && (!url || !key)) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run).');
  }

  const loaded = {};
  for (const sheet of SHEETS) {
    const file = path.isAbsolute(sheet.file) ? sheet.file : path.join(DIR, sheet.file);
    const rows = prepare(sheet, file, loaded);
    loaded[sheet.table] = new Set(rows.map((r) => r[sheet.key]));
    if (!DRY) await upload(url, key, sheet, rows);
  }

  if (DRY) {
    console.log('\nDry run complete — nothing uploaded.');
    return;
  }

  process.stdout.write('\nRefreshing rule checks… ');
  const res = await rest(url, key, 'rpc/refresh_checks', {}, {});
  console.log('done', await res.text());
  console.log('\n✔ Load complete.');
}

function prepare(sheet, file, loaded) {
  if (!fs.existsSync(file)) throw new Error(`File not found for ${sheet.table}: ${file}`);
  const records = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = records.shift() || [];
  const missing = sheet.required.filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`${path.basename(file)} is missing columns: ${missing.join(', ')}`);

  const out = [];
  const seen = new Set();
  const issues = { noKey: 0, duplicate: [], noParent: [], noGeometry: [], closed: [] };
  closedRings.length = 0;
  for (const rec of records) {
    if (rec.length === 1 && rec[0] === '') continue;
    const obj = Object.fromEntries(header.map((h, i) => [h, rec[i]]));
    const row = sheet.row(obj);
    const id = row[sheet.key];
    if (!id) { issues.noKey++; continue; }
    if (seen.has(id)) { issues.duplicate.push(id); continue; }
    if (sheet.parent && !loaded[sheet.parent.table]?.has(row[sheet.parent.field])) {
      issues.noParent.push(id);
      continue;
    }
    if ('geometry' in row && !row.geometry) issues.noGeometry.push(id);
    if (closedRings.length) { issues.closed.push(id); closedRings.length = 0; }
    seen.add(id);
    out.push(row);
  }

  console.log(`\n${sheet.table}  ←  ${path.basename(file)}`);
  console.log(`  ${out.length} rows ready`);
  if (issues.noKey) console.log(`  ! ${issues.noKey} rows skipped: empty ${sheet.key}`);
  if (issues.duplicate.length) console.log(`  ! ${issues.duplicate.length} duplicate ${sheet.key} skipped: ${preview(issues.duplicate)}`);
  if (issues.noParent.length) console.log(`  ! ${issues.noParent.length} rows skipped: ${sheet.parent.field} not in ${sheet.parent.table}: ${preview(issues.noParent)}`);
  if (issues.closed.length) console.log(`  ! ${issues.closed.length} polygons had unclosed rings (closed automatically): ${preview(issues.closed)}`);
  if (issues.noGeometry.length) console.log(`  ! ${issues.noGeometry.length} rows have no geometry (kept, not drawn): ${preview(issues.noGeometry)}`);
  return out;
}

async function upload(url, key, sheet, rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  let done = 0;
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      await withRetry(() =>
        rest(url, key, `${sheet.table}?on_conflict=${sheet.key}`, batch, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
      );
      done += batch.length;
      process.stdout.write(`\r  uploaded ${done}/${rows.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
}

async function rest(url, key, endpoint, body, headers) {
  const auth = key.startsWith('sb_')
    ? { apikey: key } // new-style secret key
    : { apikey: key, Authorization: `Bearer ${key}` }; // legacy service_role JWT
  const res = await fetch(`${url}/rest/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Profile': 'seoni', 'Accept-Profile': 'seoni', ...auth, ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

// RFC 4180 CSV parser (quoted fields, "" escapes, CRLF, newlines inside quotes)
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// GeoJSON polygons in the sheets sometimes end without repeating the first point;
// PostGIS and Google Maps both reject such rings, so close them here.
function closedGeojson(v) {
  const s = str(v);
  if (s === null) return null;
  const g = JSON.parse(s);
  const fix = (ring) => {
    const [a, b] = [ring[0], ring[ring.length - 1]];
    if (ring.length && (a[0] !== b[0] || a[1] !== b[1])) {
      closedRings.push(1);
      return [...ring, a];
    }
    return ring;
  };
  if (g.type === 'Polygon') g.coordinates = g.coordinates.map(fix);
  else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((p) => p.map(fix));
  return JSON.stringify(g);
}

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function num(v) {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}
function preview(list) {
  return list.slice(0, 5).join(', ') + (list.length > 5 ? ` …(+${list.length - 5})` : '');
}
function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}
