// Local demo backend: stands in for Supabase so the app runs with no server.
// Data comes from demo-data.json + villages/*.json (built from the four CSVs);
// answers are kept in this browser's localStorage, on the sample records
// (pre_sample_valid, eoy_sample_valid, snake_visible), like the Supabase sample tables.
(function () {
  const base = window.APP_CONFIG || {};
  const key = base.GOOGLE_MAPS_API_KEY && !/YOUR-/.test(base.GOOGLE_MAPS_API_KEY) ? base.GOOGLE_MAPS_API_KEY : 'NONE';
  window.APP_CONFIG = Object.assign({}, base, { SUPABASE_URL: 'demo', SUPABASE_ANON_KEY: 'demo', GOOGLE_MAPS_API_KEY: key });

  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'demo/demo-data.json', false);
  xhr.send();
  const M = JSON.parse(xhr.responseText);

  // ANS.treatment_samples[plot_id] / ANS.control_samples[control_plot_id] = { pre_sample_valid, eoy_sample_valid, snake_visible }
  const STORE = 'seoni-demo-answers';
  let ANS;
  try { ANS = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { ANS = {}; }
  ANS.treatment_samples = ANS.treatment_samples || {};
  ANS.control_samples = ANS.control_samples || {};
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(ANS)); } catch {} };
  const blank = { pre_sample_valid: null, eoy_sample_valid: null, snake_visible: null, snake_visible_google: null, snake_ml_esri: null };
  const treatmentRow = (id) => ({ ...M.treatment_samples[id].row, ...blank, ...ANS.treatment_samples[id] });
  const controlRow = (id) => ({ ...M.control_samples[id].row, ...blank, ...ANS.control_samples[id] });
  const controlVillage = (id) => M.control_plots[id]?.checks.village_name || M.control_samples[id]?.row.village_name;

  // one record per physical sample, like v_samples
  function samples() {
    const out = [];
    for (const id of Object.keys(M.treatment_samples)) {
      const r = treatmentRow(id);
      for (const w of ['pre', 'eoy']) out.push({ kind: 'treatment', sample: w, record_id: id, code: r[w], village_name: r.village_name, valid: r[`${w}_sample_valid`] });
    }
    for (const id of Object.keys(M.control_samples)) {
      const r = controlRow(id);
      for (const w of ['pre', 'eoy']) out.push({ kind: 'control', sample: w, record_id: id, code: r[`${w}_ids`], village_name: controlVillage(id), valid: r[`${w}_sample_valid`] });
    }
    return out;
  }

  const cpByFarmer = {};
  for (const c of Object.values(M.control_plots)) cpByFarmer[c.row.farmer_id] = c.row.plot_id;

  // Deployment plots are split per village and fetched only for villages being loaded
  const villageIndex = fetch('demo/villages.json').then((r) => r.json());
  let plotIndex = null; // plot_id -> village (for opening a plot by id)
  const villageFiles = new Map();
  const plotById = new Map();
  const plotsByFarmer = new Map();
  function loadVillage(name) {
    if (!villageFiles.has(name)) {
      villageFiles.set(name, villageIndex.then((idx) => {
        const v = idx.find((x) => x.village_name === name);
        if (!v || !v.file) return [];
        return fetch('demo/' + v.file).then((r) => r.json()).then((feats) => {
          for (const f of feats) {
            plotById.set(f.properties.plot_id, f);
            const k = f.properties.farmer_id;
            if (!plotsByFarmer.has(k)) plotsByFarmer.set(k, new Set());
            plotsByFarmer.get(k).add(f.properties.plot_id);
          }
          return feats;
        });
      }));
    }
    return villageFiles.get(name);
  }
  async function findPlot(id) {
    if (plotById.has(id)) return plotById.get(id);
    plotIndex = plotIndex || fetch('demo/plot-index.json').then((r) => r.json());
    const v = (await plotIndex)[id];
    if (!v) return null;
    await loadVillage(v);
    return plotById.get(id) || null;
  }
  const status = (r) => {
    const n = [r.pre_sample_valid, r.eoy_sample_valid, r.snake_visible, r.snake_visible_google].filter(Boolean).length;
    return n === 0 ? 'pending' : n === 4 ? 'done' : 'partial';
  };

  function queue() {
    const units = [];
    const farmersWithSample = new Set();
    for (const pid of M.sampled) {
      const t = M.treatment_plots[pid];
      farmersWithSample.add(t.row.farmer_id);
      units.push({ unit_id: 'T:' + pid, treatment_plot_id: pid, control_plot_id: cpByFarmer[t.row.farmer_id] || null, farmer_id: t.row.farmer_id, farmer_name: M.treatment_samples[pid].row.farmer_name, village_name: t.row.village_name });
    }
    for (const c of Object.values(M.control_plots)) {
      if (!farmersWithSample.has(c.row.farmer_id) && M.control_samples[c.row.plot_id]) {
        units.push({ unit_id: 'C:' + c.row.plot_id, treatment_plot_id: null, control_plot_id: c.row.plot_id, farmer_id: c.row.farmer_id, farmer_name: c.checks.farmer_name, village_name: c.checks.village_name });
      }
    }
    units.sort((a, b) => (a.village_name || '').localeCompare(b.village_name || '') || (a.farmer_name || '').localeCompare(b.farmer_name || ''));
    return units.map((u) => {
      const tpc = u.treatment_plot_id && M.treatment_plots[u.treatment_plot_id].checks;
      const tsc = u.treatment_plot_id && M.treatment_samples[u.treatment_plot_id]?.checks;
      const cpc = u.control_plot_id && M.control_plots[u.control_plot_id].checks;
      const csc = u.control_plot_id && M.control_samples[u.control_plot_id]?.checks;
      const tsv = tsc ? treatmentRow(u.treatment_plot_id) : null;
      const csv = csc ? controlRow(u.control_plot_id) : null;
      return {
        ...u,
        treatment_pre: tsc?.pre, treatment_eoy: tsc?.eoy, control_pre: csc?.pre_ids, control_eoy: csc?.eoy_ids,
        tp_control_overlap_m2: tpc?.control_overlap_m2, tp_control_overlap_pct: tpc?.control_overlap_pct, tp_plot_id_reused_as_control: tpc?.plot_id_reused_as_control,
        ts_pre_in_own_plot: tsc?.pre_in_own_plot, ts_eoy_in_own_plot: tsc?.eoy_in_own_plot,
        ts_pre_in_control: !!tsc?.pre_in_control_plot_ids, ts_eoy_in_control: !!tsc?.eoy_in_control_plot_ids,
        cp_plot_id_in_treatment: cpc?.plot_id_in_treatment, cp_treatment_overlap_m2: cpc?.treatment_overlap_m2, cp_treatment_overlap_pct: cpc?.treatment_overlap_pct,
        cp_max_single_overlap_pct: cpc?.max_single_overlap_pct, cp_treatment_samples_inside: cpc?.treatment_samples_inside,
        cs_pre_in_own_control: csc?.pre_in_own_control, cs_eoy_in_own_control: csc?.eoy_in_own_control,
        cs_pre_in_treatment: !!csc?.pre_in_treatment_plot_ids, cs_eoy_in_treatment: !!csc?.eoy_in_treatment_plot_ids,
        treatment_pre_valid: tsv?.pre_sample_valid || null, treatment_eoy_valid: tsv?.eoy_sample_valid || null, treatment_snake_visible: tsv?.snake_visible || null,
        control_pre_valid: csv?.pre_sample_valid || null, control_eoy_valid: csv?.eoy_sample_valid || null, control_snake_visible: csv?.snake_visible || null,
        ts_status: tsv ? status(tsv) : 'na',
        cs_status: csv ? status(csv) : 'na',
        has_no_answer: [tsv?.pre_sample_valid, tsv?.eoy_sample_valid, csv?.pre_sample_valid, csv?.eoy_sample_valid].includes('no'),
      };
    });
  }

  async function getUnit({ p_treatment_plot_id: tp, p_control_plot_id: cp }) {
    let farmer = null;
    const tpRecord = async (id) => {
      if (M.treatment_plots[id]) return M.treatment_plots[id];
      const f = await findPlot(id);
      return f && { row: { plot_id: id, farmer_id: f.properties.farmer_id, village_name: f.properties.village_name, crusher_code: f.properties.crusher_code }, geometry: f.geometry, checks: null };
    };
    let tpRec = null;
    if (tp) { tpRec = await tpRecord(tp); if (tpRec) farmer = tpRec.row.farmer_id; else tp = null; }
    if (cp) {
      if (!M.control_plots[cp]) cp = null;
      else if (!farmer) farmer = M.control_plots[cp].row.farmer_id;
    } else if (farmer) cp = cpByFarmer[farmer] || null;
    const farmerPlots = [...new Set([...(M.farmer_plots[farmer] || []), ...(plotsByFarmer.get(farmer) || [])])].sort((a, b) => (!M.treatment_samples[a]) - (!M.treatment_samples[b]) || a.localeCompare(b));
    if (!tp && cp) tp = farmerPlots.find((p) => M.treatment_samples[p]) || null;
    if (!tp && !cp) return null;
    return {
      farmer_id: farmer,
      farmer_name: (tp && M.treatment_samples[tp]?.row.farmer_name)
        || farmerPlots.map((p) => M.treatment_samples[p]?.row.farmer_name).find(Boolean)
        || M.control_samples[cp]?.row.farmer_name || M.control_plots[cp]?.checks.farmer_name,
      treatment_plot: (tp && (tpRec || (await tpRecord(tp)))) || null,
      treatment_sample: tp && M.treatment_samples[tp] ? { ...M.treatment_samples[tp], row: treatmentRow(tp) } : null,
      control_plot: (cp && M.control_plots[cp]) || null,
      control_sample: cp && M.control_samples[cp] ? { ...M.control_samples[cp], row: controlRow(cp) } : null,
      farmer_treatment_plots: farmerPlots.map((p) => ({ plot_id: p, has_samples: !!M.treatment_samples[p] })),
    };
  }

  const feat = (geometry, properties) => ({ type: 'Feature', geometry, properties });
  const inV = (list) => { const set = new Set(list || []); return (v) => set.has(v); };
  const RPC = {
    get_static_layers: ({ p_villages }) => {
      const has = inV(p_villages);
      return {
        control_plots: Object.values(M.control_plots).filter((c) => has(c.checks.village_name)).map((c) => feat(c.geometry, {
          plot_id: c.row.plot_id, farmer_id: c.row.farmer_id, village_name: c.checks.village_name, farmer_name: c.checks.farmer_name,
          conflict: c.checks.treatment_overlap_m2 > 0 || c.checks.plot_id_in_treatment })),
        sampled_treatment_plots: M.sampled.filter((p) => has(M.treatment_samples[p].row.village_name)).map((p) => feat(M.treatment_plots[p].geometry, {
          plot_id: p, farmer_id: M.treatment_plots[p].row.farmer_id, farmer_name: M.treatment_samples[p].row.farmer_name,
          village_name: M.treatment_samples[p].row.village_name, crusher_code: M.treatment_plots[p].row.crusher_code,
          has_samples: true, conflict: M.treatment_plots[p].checks.control_overlap_m2 > 0 })),
        treatment_samples: Object.values(M.treatment_samples).filter((s) => has(s.row.village_name)).map((s) => ({
          plot_id: s.row.plot_id, farmer_name: s.row.farmer_name, village_name: s.row.village_name,
          pre: s.row.pre, pre_lng: s.pre[0], pre_lat: s.pre[1], eoy: s.row.eoy, eoy_lng: s.eoy[0], eoy_lat: s.eoy[1] })),
        control_samples: Object.values(M.control_samples).filter((s) => has(M.control_plots[s.row.control_plot_id]?.checks.village_name)).map((s) => ({
          control_plot_id: s.row.control_plot_id, farmer_name: s.row.farmer_name, village_name: M.control_plots[s.row.control_plot_id].checks.village_name,
          pre: s.row.pre_ids, pre_lng: s.pre[0], pre_lat: s.pre[1], eoy: s.row.eoy_ids, eoy_lng: s.eoy[0], eoy_lat: s.eoy[1] })),
      };
    },
    get_villages: async () => {
      const pending = {};
      for (const x of samples()) if (!x.valid) pending[x.village_name] = (pending[x.village_name] || 0) + 1;
      return (await villageIndex).map((v) => ({ ...v, pending_samples: pending[v.village_name] || 0 }));
    },
    get_sample_progress: ({ p_villages }) => {
      const has = p_villages ? inV(p_villages) : () => true;
      const groups = new Map();
      for (const x of samples()) {
        if (!has(x.village_name)) continue;
        const k = `${x.kind}:${x.sample}`;
        const g = groups.get(k) || { kind: x.kind, sample: x.sample, total: 0, pending: 0, valid: 0, invalid: 0 };
        g.total++;
        if (!x.valid) g.pending++; else if (x.valid === 'yes') g.valid++; else g.invalid++;
        groups.set(k, g);
      }
      const order = ['treatment:pre', 'treatment:eoy', 'control:pre', 'control:eoy'];
      return order.filter((k) => groups.has(k)).map((k) => groups.get(k));
    },
    get_village_plots: async ({ p_villages }) => {
      const out = [];
      for (const v of p_villages || []) {
        for (const f of await loadVillage(v)) out.push(f);
      }
      return out;
    },
    get_unit: getUnit,
    // same contract as seoni.save_answers: one element per answer
    save_answers: ({ p }) => {
      for (const r of p) {
        const src = { treatment_samples: M.treatment_samples, control_samples: M.control_samples }[r.table];
        const cols = { snake: 'snake_visible', snake_google: 'snake_visible_google', snake_ml_esri: 'snake_ml_esri', pre: 'pre_sample_valid', eoy: 'eoy_sample_valid' };
        if (!src || !src[r.id] || !cols[r.question]) throw new Error(`${r.table} ${r.id} (${r.question}) not found`);
        const col = cols[r.question];
        ANS[r.table][r.id] = { ...ANS[r.table][r.id], [col]: r.value || null };
      }
      persist();
      return p.length;
    },
  };

  const user = { email: 'demo@local (local demo)' };
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user } } }),
        onAuthStateChange() {},
        signOut: async () => {},
        signInWithPassword: async () => ({ data: { user } }),
      },
      rpc: async (name, args) => {
        try { return { data: await RPC[name](args || {}), error: null }; }
        catch (e) { console.error(e); return { data: null, error: { message: e.message } }; }
      },
      from: (name) => {
        let lo = 0, hi = 999, filter = null;
        const b = {
          select: () => b, order: () => b,
          in: (col, vals) => { filter = (r) => vals.includes(r[col]); return b; },
          range: (a, z) => { lo = a; hi = z; return b; },
          then: (res) => {
            const tables = {
              v_review_queue: queue,
              v_samples: samples,
              treatment_samples: () => Object.keys(M.treatment_samples).map(treatmentRow),
              control_samples: () => Object.keys(M.control_samples).map(controlRow),
            };
            let rows = (tables[name] || (() => []))();
            if (filter) rows = rows.filter(filter);
            return res({ data: rows.slice(lo, hi + 1), error: null });
          },
        };
        return b;
      },
    }),
  };
})();
