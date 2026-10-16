'use strict';

// ---------------------------------------------------------------------------
// Config + constants
// ---------------------------------------------------------------------------
const CFG = Object.assign(
  {
    OVERLAP_TOLERANCE_M2: 1,
    SAME_PLOT_OVERLAP_PCT: 50,
    ALL_PLOTS_MIN_ZOOM: 13,
    MAX_PLOTS_LOADED: 8000,
    MAP_CENTER: { lat: 22.08, lng: 79.9 },
    MAP_ZOOM: 11,
    SUPABASE_SCHEMA: 'seoni',
  },
  window.APP_CONFIG || {},
);

const COLORS = {
  treat: '#fbbf24',
  control: '#22d3ee',
  tSample: '#f97316',
  cSample: '#c084fc',
  conflict: '#ef4444',
  selected: '#ffffff',
  status: { pending: '#94a3b8', partial: '#f59e0b', done: '#22c55e', no: '#ef4444' },
};
const DIAMOND = 'M 0 -6 L 6 0 L 0 6 L -6 0 Z';

const VILLAGE_KEY = 'seoni-selected-villages';

const LAYERS = [
  { id: 'villageMarkers', label: 'Village markers', swatch: 'dot', color: '#e5e7eb', filled: true, on: true },
  { id: 'allTreatment', label: 'All deployment plots', swatch: 'poly', color: COLORS.treat, dim: true, on: true },
  { id: 'sampledTreatment', label: 'Sampled treatment plots', swatch: 'poly', color: COLORS.treat, on: true },
  { id: 'control', label: 'Control plots', swatch: 'poly', color: COLORS.control, on: true },
  { id: 'tPre', label: 'Treatment pre samples', swatch: 'dot', color: COLORS.tSample, filled: true, on: true },
  { id: 'tEoy', label: 'Treatment EOY samples', swatch: 'dot', color: COLORS.tSample, on: true },
  { id: 'cPre', label: 'Control pre samples', swatch: 'diamond', color: COLORS.cSample, filled: true, on: true },
  { id: 'cEoy', label: 'Control EOY samples', swatch: 'diamond', color: COLORS.cSample, on: true },
  { id: 'conflicts', label: 'Outline overlaps in red', swatch: 'poly', color: COLORS.conflict, on: true, virtual: true },
];

// Three questions per sample row (treatment_samples / control_samples), each stored in its
// own column on that row: snake_visible, pre_sample_valid, eoy_sample_valid.
// Plot facts are shown as read-only context; the plot rules feed the system suggestion.
const SECTIONS = [
  {
    key: 'treatment_sample',
    n: 1,
    title: 'Treatment samples',
    color: COLORS.tSample,
    table: 'treatment_samples',
    id: (u) => u.treatment_sample?.row.plot_id,
    missing: () => 'This farmer has no treatment samples.',
    facts: (u) => {
      const k = u.treatment_sample.checks || {};
      return `From treatment plot <b>${esc(u.treatment_sample.row.plot_id)}</b> · pre and EOY are ${k.pre_eoy_distance_m ?? '–'} m apart`;
    },
    questions: [
      {
        key: 'snake',
        label: (u) => `Is the snake pattern visible in the background of treatment plot <b>${esc(u.treatment_sample.row.plot_id)}</b>?`,
      },
      {
        key: 'pre',
        label: (u) => `Is the pre sample <b>${esc(u.treatment_sample.row.pre)}</b> valid?`,
        auto: (u) => treatmentSampleAuto(u.treatment_sample.checks, 'pre'),
      },
      {
        key: 'eoy',
        label: (u) => `Is the EOY sample <b>${esc(u.treatment_sample.row.eoy)}</b> valid?`,
        auto: (u) => treatmentSampleAuto(u.treatment_sample.checks, 'eoy'),
      },
    ],
  },
  {
    key: 'control_sample',
    n: 2,
    title: 'Control samples',
    color: COLORS.cSample,
    table: 'control_samples',
    id: (u) => u.control_sample?.row.control_plot_id,
    missing: (u) => (u.control_plot ? 'No samples recorded for this control plot.' : 'No control plot registered for this farmer.'),
    facts: (u) => `From control plot <b>${esc(u.control_sample.row.control_plot_id)}</b>`,
    questions: [
      {
        key: 'snake',
        label: (u) => `Is the snake pattern visible in the background of control plot <b>${esc(u.control_sample.row.control_plot_id)}</b>?`,
      },
      {
        key: 'pre',
        label: (u) => `Is the pre sample <b>${esc(u.control_sample.row.pre_ids)}</b> valid?`,
        auto: (u) => controlSampleAuto(u.control_sample.checks, 'pre'),
      },
      {
        key: 'eoy',
        label: (u) => `Is the EOY sample <b>${esc(u.control_sample.row.eoy_ids)}</b> valid?`,
        auto: (u) => controlSampleAuto(u.control_sample.checks, 'eoy'),
      },
    ],
  },
];

// Column on the sample row that holds a question's answer
const answerColumn = (key) => (key === 'snake' ? 'snake_visible' : `${key}_sample_valid`);

// Treatment sample suggestion: valid when inside its own treatment plot and in no control plot
function treatmentSampleAuto(k, w) {
  if (!k) return null;
  const ctrl = k[`${w}_in_control_plot_ids`];
  const others = (k[`${w}_in_treatment_plot_ids`] || []).filter((id) => id !== k.plot_id);
  if (ctrl && ctrl.length) return { v: 'no', why: `Inside control plot ${ids(ctrl)}` };
  if (!k[`${w}_in_own_plot`]) {
    return { v: 'no', why: `${k[`${w}_dist_to_own_plot_m`]} m outside its treatment plot` + (others.length ? ` (falls in plot ${ids(others)})` : '') };
  }
  return { v: 'yes', why: 'Inside its treatment plot and not in any control plot' };
}

// Control sample suggestion: valid when inside its own control plot and in no treatment plot
function controlSampleAuto(k, w) {
  if (!k) return null;
  const treat = k[`${w}_in_treatment_plot_ids`];
  if (treat && treat.length) return { v: 'no', why: `Inside treatment plot ${ids(treat)}` };
  if (!k[`${w}_in_own_control`]) return { v: 'no', why: `${k[`${w}_dist_to_own_control_m`]} m outside its control plot` };
  return { v: 'yes', why: 'Inside its control plot and not in any treatment plot' };
}

// Read-only plot context shown above the sample questions
function plotContext(u) {
  const tol = CFG.OVERLAP_TOLERANCE_M2;
  const lines = [];
  if (u.treatment_plot) {
    const r = u.treatment_plot.row;
    const k = u.treatment_plot.checks;
    let warn = '';
    if (k?.plot_id_reused_as_control) warn = 'Same plot id is also registered as a control plot';
    else if (k && Number(k.control_overlap_m2) > tol) {
      warn = `Overlaps control plot ${ids(k.control_plot_ids)} by ${fmtM2(k.control_overlap_m2)} (${k.control_overlap_pct}% of this plot)`;
    }
    lines.push(contextLine(COLORS.treat, 'Treatment plot', [
      `<b>${esc(r.plot_id)}</b>`,
      esc(r.village_name || ''),
      r.crusher_code ? `crusher ${esc(r.crusher_code)}` : '',
      r.tonnage != null ? `${esc(r.tonnage)} t` : '',
      k?.plot_area_m2 != null ? fmtM2(k.plot_area_m2) : '',
    ], warn));
  }
  if (u.control_plot) {
    const r = u.control_plot.row;
    const k = u.control_plot.checks;
    const warns = [];
    if (k?.plot_id_in_treatment) warns.push('Plot id is also in the deployment sheet');
    else if (k && Number(k.max_single_overlap_pct) >= CFG.SAME_PLOT_OVERLAP_PCT) {
      warns.push(`${k.max_single_overlap_pct}% shared with treatment plot ${ids(k.treatment_plot_ids, 1)}, which looks like the same field`);
    } else if (k && Number(k.treatment_overlap_m2) > tol) {
      warns.push(`Overlaps ${k.overlapping_treatment_count} treatment plot(s) by ${fmtM2(k.treatment_overlap_m2)} (${k.treatment_overlap_pct}%)`);
    }
    if (k?.treatment_samples_inside > 0) warns.push(`${k.treatment_samples_inside} treatment sample(s) inside`);
    lines.push(contextLine(COLORS.control, 'Control plot', [
      `<b>${esc(r.plot_id)}</b>`,
      esc(k?.village_name || ''),
      r.surveyor_name ? `surveyor ${esc(r.surveyor_name)}` : '',
      k?.plot_area_m2 != null ? fmtM2(k.plot_area_m2) : '',
    ], warns.join('; ')));
  }
  return lines.length ? `<div class="context">${lines.join('')}</div>` : '';
}

function contextLine(color, title, parts, warn) {
  return `<div class="ctx">
    <span class="ctx-sw" style="border-color:${color};background:${hexA(color, 0.25)}"></span>
    <div>
      <div><b>${title}</b> · ${parts.filter(Boolean).join(' · ')}</div>
      ${warn ? `<div class="ctx-warn">⚠ ${esc(warn)}</div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  sb: null,
  user: null,
  started: false,
  map: null,
  data: {}, // google.maps.Data per layer id
  sel: null, // selection overlay
  layerOn: Object.fromEntries(LAYERS.map((l) => [l.id, l.on])),
  colorMode: 'type',
  counts: {},
  queue: [],
  queueIndex: new Map(),
  tpStatus: new Map(),
  cpStatus: new Map(),
  sampleAnswers: new Map(), // 'tPre:<plot_id>' / 'cEoy:<control_plot_id>' -> yes | no
  filters: { search: '', status: 'all', auto: 'all' },
  filtered: [],
  mapUnits: null,
  villages: [],
  selectedVillages: [], // villages whose data is loaded
  pickerSel: new Set(), // ticked in the picker, not yet loaded
  loadSeq: 0,
  unit: null,
  activeUnitId: null,
  answers: {},
  dirty: new Set(), // '<section>:<snake|pre|eoy>' with unsaved changes
  progressScope: 'loaded',
  selSeq: 0,
  saving: false,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

document.addEventListener('DOMContentLoaded', boot);

// ---------------------------------------------------------------------------
// Boot + auth
// ---------------------------------------------------------------------------
async function boot() {
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter((k) => !CFG[k] || /YOUR-/.test(CFG[k]));
  // Without a Maps key Google still serves a watermarked "development" map
  if (!CFG.GOOGLE_MAPS_API_KEY || /YOUR-/.test(CFG.GOOGLE_MAPS_API_KEY)) CFG.GOOGLE_MAPS_API_KEY = 'NONE';
  if (!window.APP_CONFIG || missing.length) {
    $('#setup').classList.remove('hidden');
    $('#setup-missing').textContent = window.APP_CONFIG ? `Missing: ${missing.join(', ')}` : 'web/config.js was not found.';
    return;
  }
  S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { db: { schema: CFG.SUPABASE_SCHEMA } });
  bindUi();

  const { data } = await S.sb.auth.getSession();
  if (data.session) start(data.session.user);
  else $('#login').classList.remove('hidden');

  S.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
  });
}

async function onLogin(e) {
  e.preventDefault();
  $('#login-error').textContent = '';
  $('#login-btn').disabled = true;
  const { data, error } = await S.sb.auth.signInWithPassword({
    email: $('#login-email').value.trim(),
    password: $('#login-password').value,
  });
  $('#login-btn').disabled = false;
  if (error) {
    $('#login-error').textContent = error.message;
    return;
  }
  $('#login').classList.add('hidden');
  start(data.user);
}

async function start(user) {
  if (S.started) return;
  S.started = true;
  S.user = user;
  $('#user-email').textContent = user.email || '';
  if (CFG.SUPABASE_URL === 'demo') $('.brand').insertAdjacentHTML('beforeend', ' <span class="pill partial" title="Local demo: data from the CSVs, answers saved in this browser only">DEMO</span>');
  try {
    await loadGoogleMaps();
    initMap();
    renderLayerList();
    await loadVillages();
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(VILLAGE_KEY)) || []; } catch { saved = []; }
    saved = saved.filter((v) => S.villages.some((x) => x.village_name === v));
    const hasHash = /tp=|cp=/.test(location.hash);
    if (saved.length) await setVillages(saved, { fit: !hasHash });
    else {
      applyFilters();
      loadProgress();
    }
    restoreFromHash();
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  }
}

function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.Map) return resolve();
    window.gm_authFailure = () => toast('Google Maps rejected the API key. Check the key and its referrer restrictions.', true);
    window.__gmapsReady = () =>
      Promise.all([google.maps.importLibrary('core'), google.maps.importLibrary('maps')]).then(() => resolve(), reject);
    const s = document.createElement('script');
    const key = CFG.GOOGLE_MAPS_API_KEY === 'NONE' ? '' : `key=${encodeURIComponent(CFG.GOOGLE_MAPS_API_KEY)}&`;
    s.src = `https://maps.googleapis.com/maps/api/js?${key}v=weekly&loading=async&callback=__gmapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function bindUi() {
  $('#login-form').addEventListener('submit', onLogin);
  $('#signout-btn').addEventListener('click', async () => {
    if (!confirmDiscard()) return;
    await S.sb.auth.signOut();
    location.reload();
  });

  $('#village-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#village-menu');
    const opening = menu.classList.contains('hidden');
    $('#export-menu').classList.add('hidden');
    menu.classList.toggle('hidden', !opening);
    if (opening) {
      S.pickerSel = new Set(S.selectedVillages);
      $('#village-search').value = '';
      renderVillageList();
      $('#village-search').focus();
    }
  });
  $('#village-menu').addEventListener('click', (e) => e.stopPropagation());
  $('#village-search').addEventListener('input', renderVillageList);
  $('#village-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-v]');
    if (!cb) return;
    if (cb.checked) S.pickerSel.add(cb.dataset.v);
    else S.pickerSel.delete(cb.dataset.v);
    updateVillageTotal();
  });
  $('#village-clear').addEventListener('click', () => {
    S.pickerSel.clear();
    renderVillageList();
  });
  $('#village-apply').addEventListener('click', () => {
    $('#village-menu').classList.add('hidden');
    setVillages([...S.pickerSel], { fit: true });
  });

  let t;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      S.filters.search = e.target.value.trim().toLowerCase();
      applyFilters();
    }, 150);
  });
  $('#f-search').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    if (S.filtered.length) return openRow(S.filtered[0]);
    if (/^\d+$/.test(q)) {
      const found = (await selectUnit({ tp: q })) || (await selectUnit({ cp: q }));
      if (!found) toast(`No plot ${q} found`, true);
    }
  });

  chipGroup('#f-status', (v) => { S.filters.status = v; applyFilters(); });
  chipGroup('#f-auto', (v) => { S.filters.auto = v; applyFilters(); });

  $$('#color-mode button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#color-mode button').forEach((x) => x.classList.toggle('on', x === b));
      S.colorMode = b.dataset.mode;
      restyle();
    }),
  );

  $('#export-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#export-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    $('#export-menu').classList.add('hidden');
    $('#village-menu').classList.add('hidden');
  });
  $$('#export-menu button').forEach((b) => b.addEventListener('click', () => exportTable(b.dataset.export)));

  $('#queue').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-unit]');
    if (li) openRow(S.queueIndex.get(li.dataset.unit));
  });

  $('#sections').addEventListener('click', onSectionClick);
  $$('#progress-scope button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#progress-scope button').forEach((x) => x.classList.toggle('on', x === b));
      S.progressScope = b.dataset.scope;
      loadProgress();
    }),
  );
  $('#review-head').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tp]');
    if (b) selectUnit({ tp: b.dataset.tp });
  });
  $('#review-form').addEventListener('submit', (e) => {
    e.preventDefault();
    save(false);
  });
  $('#save-next-btn').addEventListener('click', () => save(true));
  $('#zoom-btn').addEventListener('click', zoomToUnit);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && S.unit) {
      e.preventDefault();
      save(false);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function chipGroup(sel, onChange) {
  $$(`${sel} button`).forEach((b) =>
    b.addEventListener('click', () => {
      $$(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b));
      onChange(b.dataset.v);
    }),
  );
}

function renderLayerList() {
  $('#layer-list').innerHTML = LAYERS.map((l) => {
    const style =
      l.swatch === 'poly'
        ? `border-color:${l.color};background:${l.dim ? 'transparent' : hexA(l.color, 0.25)}`
        : `border-color:${l.color};background:${l.filled ? l.color : '#fff'}`;
    return `<label class="layer">
      <input type="checkbox" data-layer="${l.id}" ${S.layerOn[l.id] ? 'checked' : ''} />
      <span class="sw ${l.swatch}" style="${style}"></span>
      <span>${l.label}</span>
      <span class="count" data-count="${l.id}"></span>
    </label>`;
  }).join('');
  $$('#layer-list input').forEach((cb) =>
    cb.addEventListener('change', () => {
      S.layerOn[cb.dataset.layer] = cb.checked;
      syncLayerVisibility();
      if (cb.dataset.layer === 'conflicts') restyle();
    }),
  );
}

function setCount(id, text) {
  const el = $(`[data-count="${id}"]`);
  if (el) el.textContent = text;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  S.map = new google.maps.Map($('#map'), {
    center: CFG.MAP_CENTER,
    zoom: CFG.MAP_ZOOM,
    mapTypeId: 'hybrid',
    tilt: 0,
    gestureHandling: 'greedy',
    clickableIcons: false,
    streetViewControl: false,
    scaleControl: true,
    fullscreenControl: true,
    mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
  });

  for (const l of LAYERS) {
    if (l.virtual) continue;
    const d = new google.maps.Data();
    d.setStyle((f) => styleFor(l.id, f));
    d.addListener('click', (e) => onFeatureClick(l.id, e.feature));
    d.addListener('mouseover', (e) => setMapStatus(describe(l.id, e.feature)));
    d.addListener('mouseout', () => setMapStatus(''));
    S.data[l.id] = d;
  }
  S.sel = new google.maps.Data({ map: S.map });
  S.sel.setStyle((f) => {
    const kind = f.getProperty('kind');
    if (f.getGeometry().getType() === 'Point') {
      return {
        clickable: false,
        zIndex: 60,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 11, fillOpacity: 0, strokeColor: COLORS.selected, strokeWeight: 2.5 },
      };
    }
    return {
      clickable: false,
      zIndex: 50,
      fillOpacity: 0,
      strokeColor: COLORS.selected,
      strokeWeight: kind === 'tp' ? 4 : 3.5,
    };
  });

  syncLayerVisibility();
  S.map.addListener('idle', syncLayerVisibility);
}

function syncLayerVisibility() {
  const z = S.map.getZoom() ?? 0;
  for (const l of LAYERS) {
    if (l.virtual) continue;
    let on = S.layerOn[l.id];
    if (l.id === 'allTreatment') on = on && z >= CFG.ALL_PLOTS_MIN_ZOOM;
    if (l.id === 'villageMarkers') on = on && z < 15;
    const want = on ? S.map : null;
    if (S.data[l.id].getMap() !== want) S.data[l.id].setMap(want);
  }
  $('#zoom-hint').textContent =
    S.selectedVillages.length && S.layerOn.allTreatment && z < CFG.ALL_PLOTS_MIN_ZOOM
      ? `All deployment plots are drawn from zoom ${CFG.ALL_PLOTS_MIN_ZOOM} (now ${z}).`
      : '';
}

function restyle() {
  for (const [id, d] of Object.entries(S.data)) d.setStyle((f) => styleFor(id, f));
}

function statusColor(st) {
  return COLORS.status[st] || COLORS.status.pending;
}

function styleFor(id, f) {
  const visible = passesMapFilter(id, f);
  const conflictOn = S.layerOn.conflicts && f.getProperty('conflict');
  switch (id) {
    case 'villageMarkers': {
      const loaded = S.selectedVillages.includes(f.getProperty('village_name'));
      return {
        visible,
        zIndex: 30,
        title: f.getProperty('village_name'),
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: loaded ? COLORS.status.done : '#e5e7eb', fillOpacity: 0.95, strokeColor: '#0b0f14', strokeWeight: 1.5, labelOrigin: new google.maps.Point(0, -2.8) },
        label: { text: f.getProperty('village_name'), color: '#ffffff', fontSize: '11px', fontWeight: '600' },
      };
    }
    case 'allTreatment': {
      let c = COLORS.treat;
      if (S.colorMode === 'status') c = '#94a3b8'; // unsampled plots have nothing to review
      return { visible, zIndex: 1, strokeColor: conflictOn ? COLORS.conflict : c, strokeOpacity: 0.85, strokeWeight: conflictOn ? 2 : 1, fillColor: c, fillOpacity: 0.06 };
    }
    case 'sampledTreatment': {
      let c = COLORS.treat;
      if (S.colorMode === 'status') c = statusColor(S.tpStatus.get(f.getProperty('plot_id')));
      return { visible, zIndex: 2, strokeColor: conflictOn ? COLORS.conflict : c, strokeWeight: conflictOn ? 3 : 2, fillColor: c, fillOpacity: 0.2 };
    }
    case 'control': {
      let c = COLORS.control;
      if (S.colorMode === 'status') c = statusColor(S.cpStatus.get(f.getProperty('plot_id')));
      return { visible, zIndex: 3, strokeColor: conflictOn ? COLORS.conflict : c, strokeWeight: conflictOn ? 3 : 2, fillColor: c, fillOpacity: 0.25 };
    }
    case 'tPre':
    case 'tEoy':
    case 'cPre':
    case 'cEoy': {
      const isPre = id.endsWith('Pre');
      const isTreatment = id.startsWith('t');
      let c = isTreatment ? COLORS.tSample : COLORS.cSample;
      if (S.colorMode === 'status') {
        const ans = S.sampleAnswers.get(`${id}:${f.getProperty(isTreatment ? 'plot_id' : 'control_plot_id')}`);
        c = ans === 'yes' ? COLORS.status.done : ans === 'no' ? COLORS.status.no : COLORS.status.pending;
      }
      return {
        visible,
        zIndex: { tPre: 10, tEoy: 11, cPre: 12, cEoy: 13 }[id],
        icon: {
          path: isTreatment ? google.maps.SymbolPath.CIRCLE : DIAMOND,
          scale: isTreatment ? 5 : 1,
          fillColor: isPre ? c : '#ffffff',
          fillOpacity: 1,
          strokeColor: isPre ? '#111111' : c,
          strokeWeight: isPre ? 1.5 : 2.5,
        },
      };
    }
    default:
      return {};
  }
}

function passesMapFilter(id, f) {
  if (S.mapUnits && id !== 'allTreatment' && id !== 'villageMarkers') {
    if (id === 'sampledTreatment' || id === 'tPre' || id === 'tEoy') return S.mapUnits.tp.has(f.getProperty('plot_id'));
    if (id === 'control') return S.mapUnits.cp.has(f.getProperty('plot_id'));
    if (id === 'cPre' || id === 'cEoy') return S.mapUnits.cp.has(f.getProperty('control_plot_id'));
  }
  return true;
}

function describe(id, f) {
  const p = (k) => f.getProperty(k);
  const who = p('farmer_name') || (p('farmer_id') ? `farmer ${p('farmer_id')}` : '');
  const tail = [who, p('village_name')].filter(Boolean).join(' · ');
  const warn = p('conflict') ? ' · ⚠ overlaps' : '';
  switch (id) {
    case 'villageMarkers':
      return `${p('village_name')} · ${p('plots')} plots · ${p('sampled')} sampled plots · ${p('controls')} control plots — ${S.selectedVillages.includes(p('village_name')) ? 'loaded (click to zoom)' : 'click to load'}`;
    case 'allTreatment':
    case 'sampledTreatment':
      return `Treatment plot ${p('plot_id')}${p('has_samples') ? ' (sampled)' : ''} · ${tail}${warn}`;
    case 'control':
      return `Control plot ${p('plot_id')} · ${tail}${warn}`;
    case 'tPre':
    case 'tEoy':
      return `Treatment ${id === 'tPre' ? 'PRE' : 'EOY'} sample ${p('code')} · plot ${p('plot_id')} · ${tail}`;
    case 'cPre':
    case 'cEoy':
      return `Control ${id === 'cPre' ? 'PRE' : 'EOY'} sample ${p('code')} · control plot ${p('control_plot_id')} · ${tail}`;
    default:
      return '';
  }
}

function setMapStatus(text) {
  $('#map-status').textContent = text;
}

function onFeatureClick(id, f) {
  if (id === 'villageMarkers') {
    const v = f.getProperty('village_name');
    if (S.selectedVillages.includes(v)) return fitVillages([v]);
    return setVillages([...S.selectedVillages, v], { fit: false }).then(() => fitVillages([v]));
  }
  if (id === 'control') return selectUnit({ cp: f.getProperty('plot_id') });
  if (id === 'cPre' || id === 'cEoy') return selectUnit({ cp: f.getProperty('control_plot_id') });
  return selectUnit({ tp: f.getProperty('plot_id') });
}

// Pending / valid / invalid counts per sample type, for the loaded villages or all villages
async function loadProgress() {
  const el = $('#sample-progress');
  if (S.progressScope === 'loaded' && !S.selectedVillages.length) {
    el.innerHTML = '<p class="muted small">Load villages to see their counts, or switch to “All villages”.</p>';
    return;
  }
  const { data, error } = await S.sb.rpc('get_sample_progress', {
    p_villages: S.progressScope === 'loaded' ? S.selectedVillages : null,
  });
  if (error) {
    el.innerHTML = `<p class="error small">${esc(error.message)}</p>`;
    return;
  }
  const rows = data || [];
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
  const label = { treatment: 'Treatment', control: 'Control' };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const total = sum('total');
  const pending = sum('pending');
  el.innerHTML = `
    <div class="progress-head"><b>${fmt(pending)}</b> of ${fmt(total)} samples pending</div>
    <div class="progress"><div style="width:${total ? ((total - pending) / total) * 100 : 0}%"></div></div>
    <table class="sp">
      <thead><tr><th></th><th>Pending</th><th>Valid</th><th>Invalid</th><th>Total</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr><td>${label[r.kind]} ${r.sample === 'pre' ? 'pre' : 'EOY'}</td><td class="pend">${fmt(r.pending)}</td><td class="ok">${fmt(r.valid)}</td><td class="bad">${fmt(r.invalid)}</td><td>${fmt(r.total)}</td></tr>`).join('')}
        <tr class="tot"><td>All samples</td><td class="pend">${fmt(pending)}</td><td class="ok">${fmt(sum('valid'))}</td><td class="bad">${fmt(sum('invalid'))}</td><td>${fmt(total)}</td></tr>
      </tbody>
    </table>`;
}

async function refreshVillageCounts() {
  const { data, error } = await S.sb.rpc('get_villages');
  if (!error && data) S.villages = data;
}

// Load (or unload) everything for the chosen villages. Nothing is fetched before a village is picked.
async function setVillages(list, opts = {}) {
  const chosen = [...new Set(list)].sort();
  const total = plotsIn(chosen);
  if (total > CFG.MAX_PLOTS_LOADED) {
    toast(`${total.toLocaleString()} plots is more than the ${CFG.MAX_PLOTS_LOADED.toLocaleString()} limit. Pick fewer villages.`, true);
    return;
  }
  S.selectedVillages = chosen;
  try { localStorage.setItem(VILLAGE_KEY, JSON.stringify(chosen)); } catch { /* storage unavailable */ }
  updateVillageButton();
  const seq = ++S.loadSeq;

  for (const l of LAYERS) {
    if (l.virtual || l.id === 'villageMarkers') continue;
    const d = S.data[l.id];
    d.forEach((f) => d.remove(f));
    setCount(l.id, '');
  }
  $('#map-prompt').classList.toggle('hidden', chosen.length > 0);
  restyle();
  if (!chosen.length) {
    S.queue = [];
    S.queueIndex = new Map();
    applyFilters();
    syncLayerVisibility();
    loadProgress();
    return;
  }

  $('#map-loading').textContent = `Loading ${chosen.length} village${chosen.length > 1 ? 's' : ''} · ${total.toLocaleString()} plots…`;
  $('#map-loading').classList.remove('hidden');
  try {
    const [layers, plots] = await Promise.all([
      S.sb.rpc('get_static_layers', { p_villages: chosen }),
      S.sb.rpc('get_village_plots', { p_villages: chosen }),
      loadQueue(),
      loadProgress(),
    ]);
    if (seq !== S.loadSeq) return;
    if (layers.error) throw layers.error;
    if (plots.error) throw plots.error;
    addStaticLayers(layers.data);
    // sampled plots already live in their own layer
    const rest = (plots.data || []).filter((f) => !f.properties.has_samples);
    S.data.allTreatment.addGeoJson({ type: 'FeatureCollection', features: closedFeatures(rest) }, { idPropertyName: 'plot_id' });
    setCount('allTreatment', rest.length);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  } finally {
    if (seq === S.loadSeq) $('#map-loading').classList.add('hidden');
  }
  syncLayerVisibility();
  if (opts.fit) fitVillages(chosen);
}

function addStaticLayers(data) {
  const fc = (features) => ({ type: 'FeatureCollection', features: closedFeatures(features) });
  const points = (rows, which, extra) =>
    fc(
      rows
        .filter((r) => r[`${which}_lng`] != null && r[`${which}_lat`] != null)
        .map((r) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r[`${which}_lng`], r[`${which}_lat`]] },
          properties: { ...extra(r), code: r[which], farmer_name: r.farmer_name, village_name: r.village_name },
        })),
    );

  S.data.sampledTreatment.addGeoJson(fc(data.sampled_treatment_plots), { idPropertyName: 'plot_id' });
  S.data.control.addGeoJson(fc(data.control_plots), { idPropertyName: 'plot_id' });
  const ts = data.treatment_samples || [];
  const cs = data.control_samples || [];
  S.data.tPre.addGeoJson(points(ts, 'pre', (r) => ({ plot_id: r.plot_id })));
  S.data.tEoy.addGeoJson(points(ts, 'eoy', (r) => ({ plot_id: r.plot_id })));
  S.data.cPre.addGeoJson(points(cs, 'pre', (r) => ({ control_plot_id: r.control_plot_id })));
  S.data.cEoy.addGeoJson(points(cs, 'eoy', (r) => ({ control_plot_id: r.control_plot_id })));

  setCount('sampledTreatment', (data.sampled_treatment_plots || []).length);
  setCount('control', (data.control_plots || []).length);
  setCount('tPre', ts.length);
  setCount('tEoy', ts.length);
  setCount('cPre', cs.length);
  setCount('cEoy', cs.length);
}

function fitVillages(names) {
  const b = new google.maps.LatLngBounds();
  for (const v of S.villages) {
    if (!names.includes(v.village_name) || !v.bbox) continue;
    b.extend({ lng: v.bbox[0], lat: v.bbox[1] });
    b.extend({ lng: v.bbox[2], lat: v.bbox[3] });
  }
  if (!b.isEmpty()) S.map.fitBounds(b, 40);
}

function plotsIn(names) {
  return S.villages.filter((v) => names.includes(v.village_name)).reduce((n, v) => n + (v.plots || 0), 0);
}

function updateVillageButton() {
  const n = S.selectedVillages.length;
  $('#village-btn').textContent =
    n === 0 ? 'Select villages ▾' : n <= 2 ? `${S.selectedVillages.join(', ')} ▾` : `${n} villages ▾`;
}

function renderVillageList() {
  const q = $('#village-search').value.trim().toLowerCase();
  $('#village-list').innerHTML = S.villages
    .filter((v) => !q || v.village_name.toLowerCase().includes(q))
    .map((v) => `<label>
      <input type="checkbox" data-v="${esc(v.village_name)}" ${S.pickerSel.has(v.village_name) ? 'checked' : ''} />
      <span>${esc(v.village_name)}</span>
      <span class="vc">${v.plots} · <b class="${v.pending_samples ? 'pend' : 'ok'}">${v.pending_samples ?? '–'}</b></span>
    </label>`)
    .join('') || '<div class="muted small" style="padding:6px">No village matches.</div>';
  updateVillageTotal();
}

function updateVillageTotal() {
  const names = [...S.pickerSel];
  const total = plotsIn(names);
  const over = total > CFG.MAX_PLOTS_LOADED;
  const el = $('#village-total');
  el.textContent = names.length
    ? `${names.length} village${names.length > 1 ? 's' : ''} · ${total.toLocaleString()} plots${over ? ` (max ${CFG.MAX_PLOTS_LOADED.toLocaleString()})` : ''}`
    : 'Nothing selected';
  el.classList.toggle('over', over);
  $('#village-apply').disabled = over;
  $('#village-apply').textContent = names.length ? 'Load' : 'Unload all';
}

// Google Maps rejects a whole batch if any ring isn't closed; the source sheets have some.
function closeRings(geom) {
  if (!geom) return geom;
  const fix = (ring) => {
    const a = ring[0];
    const b = ring[ring.length - 1];
    return ring.length && (a[0] !== b[0] || a[1] !== b[1]) ? [...ring, a] : ring;
  };
  if (geom.type === 'Polygon') return { ...geom, coordinates: geom.coordinates.map(fix) };
  if (geom.type === 'MultiPolygon') return { ...geom, coordinates: geom.coordinates.map((p) => p.map(fix)) };
  return geom;
}
const closedFeatures = (features) => (features || []).map((f) => ({ ...f, geometry: closeRings(f.geometry) }));

function extendBounds(bounds, geom) {
  if (!geom) return;
  if (geom instanceof google.maps.LatLng) bounds.extend(geom);
  else if (geom.forEachLatLng) geom.forEachLatLng((ll) => bounds.extend(ll));
}

function drawSelection() {
  S.sel.forEach((f) => S.sel.remove(f));
  const u = S.unit;
  if (!u) return;
  const feats = [];
  const poly = (g, kind) => g && feats.push({ type: 'Feature', geometry: closeRings(g), properties: { kind } });
  const pt = (c, kind) => c && c[0] != null && c[1] != null && feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind } });
  poly(u.treatment_plot?.geometry, 'tp');
  poly(u.control_plot?.geometry, 'cp');
  pt(u.treatment_sample?.pre, 'tpre');
  pt(u.treatment_sample?.eoy, 'teoy');
  pt(u.control_sample?.pre, 'cpre');
  pt(u.control_sample?.eoy, 'ceoy');
  S.sel.addGeoJson({ type: 'FeatureCollection', features: feats });
}

function zoomToUnit() {
  const b = new google.maps.LatLngBounds();
  S.sel.forEach((f) => extendBounds(b, f.getGeometry()));
  if (b.isEmpty()) return;
  S.map.fitBounds(b, 90);
  google.maps.event.addListenerOnce(S.map, 'idle', () => {
    if (S.map.getZoom() > 19) S.map.setZoom(19);
  });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
async function loadVillages() {
  const { data, error } = await S.sb.rpc('get_villages');
  if (error) throw error;
  S.villages = data || [];
  const markers = S.villages
    .filter((v) => v.bbox)
    .map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(v.bbox[0] + v.bbox[2]) / 2, (v.bbox[1] + v.bbox[3]) / 2] },
      properties: { village_name: v.village_name, plots: v.plots, sampled: v.sampled, controls: v.controls },
    }));
  S.data.villageMarkers.addGeoJson({ type: 'FeatureCollection', features: markers });
  setCount('villageMarkers', S.villages.length);
  updateVillageButton();
}

async function loadQueue() {
  const rows = [];
  for (let from = 0; S.selectedVillages.length; from += 1000) {
    const { data, error } = await S.sb
      .from('v_review_queue')
      .select('*')
      .in('village_name', S.selectedVillages)
      .order('village_name', { ascending: true })
      .order('farmer_name', { ascending: true })
      .order('unit_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  S.tpStatus = new Map();
  S.cpStatus = new Map();
  S.sampleAnswers = new Map();
  for (const r of rows) {
    r._flags = rowFlags(r);
    r._status = rowStatus(r);
    r._search = [
      r.farmer_name, r.farmer_id, r.village_name, r.treatment_plot_id, r.control_plot_id,
      r.treatment_pre, r.treatment_eoy, r.control_pre, r.control_eoy,
    ].filter(Boolean).join(' ').toLowerCase();
    const tNo = r.treatment_pre_valid === 'no' || r.treatment_eoy_valid === 'no';
    const cNo = r.control_pre_valid === 'no' || r.control_eoy_valid === 'no';
    if (r.treatment_plot_id) S.tpStatus.set(r.treatment_plot_id, tNo ? 'no' : r.ts_status);
    if (r.control_plot_id && r.cs_status !== 'na') S.cpStatus.set(r.control_plot_id, cNo ? 'no' : r.cs_status);
    const ans = { tPre: [r.treatment_plot_id, r.treatment_pre_valid], tEoy: [r.treatment_plot_id, r.treatment_eoy_valid], cPre: [r.control_plot_id, r.control_pre_valid], cEoy: [r.control_plot_id, r.control_eoy_valid] };
    for (const [k, [key, v]] of Object.entries(ans)) if (key && v) S.sampleAnswers.set(`${k}:${key}`, v);
  }
  S.queue = rows;
  S.queueIndex = new Map(rows.map((r) => [r.unit_id, r]));
  applyFilters();
}

// Number of samples the system suggests are invalid
function rowFlags(r) {
  let n = 0;
  if (r.treatment_pre) {
    if (!r.ts_pre_in_own_plot || r.ts_pre_in_control) n++;
    if (!r.ts_eoy_in_own_plot || r.ts_eoy_in_control) n++;
  }
  if (r.control_pre) {
    if (r.cs_pre_in_treatment || !r.cs_pre_in_own_control) n++;
    if (r.cs_eoy_in_treatment || !r.cs_eoy_in_own_control) n++;
  }
  return n;
}

function rowStatus(r) {
  const s = [r.ts_status, r.cs_status].filter((x) => x && x !== 'na');
  if (!s.length || s.every((x) => x === 'done')) return 'done';
  if (s.every((x) => x === 'pending')) return 'pending';
  return 'partial';
}

function applyFilters() {
  const f = S.filters;
  S.filtered = S.queue.filter((r) => {
    if (f.search && !r._search.includes(f.search)) return false;
    if (f.status === 'no' ? !r.has_no_answer : f.status !== 'all' && r._status !== f.status) return false;
    if (f.auto === 'flagged' && !r._flags) return false;
    if (f.auto === 'clean' && r._flags) return false;
    return true;
  });

  const narrowed = f.search || f.status !== 'all' || f.auto !== 'all';
  S.mapUnits = narrowed
    ? {
        tp: new Set(S.filtered.map((r) => r.treatment_plot_id).filter(Boolean)),
        cp: new Set(S.filtered.map((r) => r.control_plot_id).filter(Boolean)),
      }
    : null;

  renderQueue();
  if (S.map) restyle();
}

function renderQueue() {
  const rows = S.filtered;
  const done = rows.filter((r) => r._status === 'done').length;
  $('#queue-count').textContent = `${done} / ${rows.length} done`;
  $('#progress-bar').style.width = rows.length ? `${(done / rows.length) * 100}%` : '0';
  const statusLabel = { pending: 'Pending', partial: 'Partial', done: 'Done' };
  $('#queue').innerHTML =
    rows
      .map((r) => {
        const sub = [
          r.village_name,
          r.treatment_plot_id ? `T ${r.treatment_plot_id}` : 'no sampled plot',
          r.control_plot_id ? `C ${r.control_plot_id}` : 'no control',
        ].filter(Boolean).join(' · ');
        return `<li data-unit="${esc(r.unit_id)}" class="${r.unit_id === S.activeUnitId ? 'active' : ''}">
          <span class="q-name">${esc(r.farmer_name || `Farmer ${r.farmer_id}`)}</span>
          <span class="q-badges">
            <span class="pill ${r._status}">${statusLabel[r._status]}</span>
            ${r.has_no_answer ? '<span class="pill no">Invalid sample</span>' : ''}
            ${r._flags ? `<span class="pill flag" title="Samples the system suggests are invalid">⚠ ${r._flags}</span>` : ''}
          </span>
          <span class="q-sub">${esc(sub)}</span>
        </li>`;
      })
      .join('') ||
    `<li class="muted">${S.selectedVillages.length ? 'No units match the filters.' : 'Select villages to load the review queue.'}</li>`;
}

function openRow(r) {
  if (!r) return;
  selectUnit({ tp: r.treatment_plot_id, cp: r.control_plot_id, unitId: r.unit_id });
}

function findUnitId(u) {
  const tp = u.treatment_plot?.row.plot_id;
  const cp = u.control_plot?.row.plot_id;
  if (tp && S.queueIndex.has(`T:${tp}`)) return `T:${tp}`;
  if (cp && S.queueIndex.has(`C:${cp}`)) return `C:${cp}`;
  return null;
}

function highlightActive() {
  $$('#queue li[data-unit]').forEach((li) => li.classList.toggle('active', li.dataset.unit === S.activeUnitId));
  const el = $(`#queue li[data-unit="${CSS.escape(S.activeUnitId || '')}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Review form
// ---------------------------------------------------------------------------
function confirmDiscard() {
  return !S.dirty.size || confirm('You have unsaved answers. Discard them?');
}

async function selectUnit(sel, opts = {}) {
  if (!opts.force && !confirmDiscard()) return false;
  const seq = ++S.selSeq;
  $('#save-state').textContent = 'Loading…';
  const { data, error } = await S.sb.rpc('get_unit', {
    p_treatment_plot_id: sel.tp || null,
    p_control_plot_id: sel.cp || null,
  });
  if (seq !== S.selSeq) return false;
  $('#save-state').textContent = '';
  if (error) {
    toast(error.message, true);
    return false;
  }
  if (!data) return false;

  S.unit = data;
  S.activeUnitId = sel.unitId || findUnitId(data);
  S.dirty.clear();
  S.answers = {};
  for (const def of SECTIONS) {
    const sec = data[def.key];
    if (!sec) continue;
    S.answers[def.key] = Object.fromEntries(def.questions.map((q) => [q.key, sec.row[answerColumn(q.key)] || null]));
  }

  const tp = data.treatment_plot?.row.plot_id;
  const cp = data.control_plot?.row.plot_id;
  history.replaceState(null, '', `#${new URLSearchParams(Object.entries({ tp, cp }).filter(([, v]) => v)).toString()}`);

  renderReview();
  drawSelection();
  if (!opts.noZoom) zoomToUnit();
  highlightActive();

  // a unit opened by id / hash / farmer-plot button may sit in a village that isn't loaded yet
  const v = data.treatment_plot?.row.village_name || data.control_plot?.checks?.village_name;
  if (v && !S.selectedVillages.includes(v) && S.villages.some((x) => x.village_name === v)) {
    setVillages([...S.selectedVillages, v]).then(() => {
      S.activeUnitId = S.activeUnitId || findUnitId(data);
      highlightActive();
    });
  }
  return true;
}

function restoreFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const tp = p.get('tp');
  const cp = p.get('cp');
  if (tp || cp) selectUnit({ tp, cp }, { force: true });
}

function renderReview() {
  const u = S.unit;
  $('#review-empty').classList.add('hidden');
  $('#review-form').classList.remove('hidden');

  const village = u.treatment_plot?.row.village_name || u.control_plot?.checks?.village_name || '';
  const currentTp = u.treatment_plot?.row.plot_id;
  const plots = u.farmer_treatment_plots || [];
  const shown = plots.slice(0, 40);
  $('#review-head').innerHTML = `
    <div class="title">${esc(u.farmer_name || `Farmer ${u.farmer_id || '–'}`)}</div>
    <div class="meta">Farmer ID ${esc(u.farmer_id || '–')} · ${esc(village)}${S.activeUnitId ? '' : ' · <span title="Not in the review queue">ad-hoc plot</span>'}</div>
    ${plots.length ? `<div class="meta small">Farmer’s treatment plots (${plots.length}) · outlined = sampled</div>
    <div class="farmer-plots">${shown
      .map((p) => `<button type="button" data-tp="${esc(p.plot_id)}" class="${p.has_samples ? 'sampled' : ''} ${p.plot_id === currentTp ? 'current' : ''}">${esc(p.plot_id)}</button>`)
      .join('')}${plots.length > shown.length ? `<span class="muted small">+${plots.length - shown.length} more</span>` : ''}</div>` : ''}`;

  $('#sections').innerHTML = plotContext(u) + SECTIONS.map((def) => renderSection(def, u)).join('');
  updateSaveState();
}

function renderSection(def, u) {
  const sec = u[def.key];
  const head = (extra = '') => `
    <div class="section-head">
      <span class="num" style="background:${def.color}">${def.n}</span>
      <span class="name">${def.title}</span>
      ${extra}
    </div>`;
  if (!sec) return `<div class="section na" data-section="${def.key}">${head()}<div class="muted small">${def.missing(u)}</div></div>`;

  const a = S.answers[def.key];
  const hasAuto = def.questions.some((q) => q.auto);
  const answered = def.questions.filter((q) => sec.row[answerColumn(q.key)]).length;

  const qs = def.questions
    .map((q) => {
      const ans = a[q.key];
      const auto = q.auto ? q.auto(u) : null;
      let hint = '<div class="hint manual">Visual check on the satellite imagery</div>';
      if (auto) {
        const mismatch = ans && ans !== auto.v ? '<span class="mismatch">· differs from your answer</span>' : '';
        hint = `<div class="hint ${auto.v === 'yes' ? 'ok' : 'bad'}">${auto.v === 'yes' ? '✓' : '⚠'} System suggests <b>${auto.v === 'yes' ? 'VALID' : 'INVALID'}</b>: ${esc(auto.why)} ${mismatch}</div>`;
      } else if (q.auto) {
        hint = '<div class="hint manual">No system check available (checks not refreshed?)</div>';
      }
      const unsaved = S.dirty.has(`${def.key}:${q.key}`) ? ' <span class="unsaved">· unsaved</span>' : '';
      return `<div class="q">
        <div class="q-label">${q.label(u)}${unsaved}</div>
        <div class="yn" data-section="${def.key}" data-q="${q.key}">
          <button type="button" data-v="yes" class="${ans === 'yes' ? 'on' : ''}">Yes</button>
          <button type="button" data-v="no" class="${ans === 'no' ? 'on' : ''}">No</button>
        </div>
        ${hint}
      </div>`;
    })
    .join('');

  return `<div class="section" data-section="${def.key}">
    ${head(`<span class="ids">${esc(def.id(u))}</span><span class="saved">${answered} / ${def.questions.length} answered</span>`)}
    <div class="facts">${def.facts(u)}</div>
    ${qs}
    ${hasAuto ? `<button type="button" class="apply-auto" data-apply="${def.key}">Fill unanswered samples with system suggestions</button>` : ''}
  </div>`;
}

function onSectionClick(e) {
  const btn = e.target.closest('.yn button');
  if (btn) {
    const { section, q } = btn.parentElement.dataset;
    const a = S.answers[section];
    a[q] = a[q] === btn.dataset.v ? null : btn.dataset.v; // click again to clear
    S.dirty.add(`${section}:${q}`);
    updateSaveState();
    rerenderSection(section);
    return;
  }
  const apply = e.target.closest('[data-apply]');
  if (apply) {
    const def = SECTIONS.find((d) => d.key === apply.dataset.apply);
    let changed = false;
    for (const q of def.questions) {
      const auto = q.auto && q.auto(S.unit);
      const a = S.answers[def.key];
      if (auto && !a[q.key]) {
        a[q.key] = auto.v;
        S.dirty.add(`${def.key}:${q.key}`);
        changed = true;
      }
    }
    if (changed) {
      updateSaveState();
      rerenderSection(def.key);
    }
  }
}

function rerenderSection(key) {
  const def = SECTIONS.find((d) => d.key === key);
  const el = $(`.section[data-section="${key}"]`);
  const html = renderSection(def, S.unit);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  el.replaceWith(tmp.firstElementChild);
}

function updateSaveState() {
  const n = S.dirty.size;
  $('#save-state').textContent = n ? `${n} answer${n > 1 ? 's' : ''} not saved` : '';
  $('#save-btn').disabled = !n || S.saving;
}

async function save(next) {
  if (!S.unit || S.saving) return;
  const nextRow = next ? nextQueueRow() : null;
  if (!S.dirty.size) {
    if (next) nextRow ? openRow(nextRow) : toast('End of the queue');
    return;
  }

  // one entry per changed answer; each is written into its own column on the sample row
  const u = S.unit;
  const payload = [];
  for (const def of SECTIONS) {
    if (!u[def.key]) continue;
    for (const q of def.questions) {
      if (!S.dirty.has(`${def.key}:${q.key}`)) continue;
      payload.push({ table: def.table, id: def.id(u), question: q.key, value: S.answers[def.key][q.key] });
    }
  }
  const unanswered = payload.filter((p) => !p.value).length;

  S.saving = true;
  updateSaveState();
  $('#save-state').textContent = 'Saving…';
  const { error } = await S.sb.rpc('save_answers', { p: payload });
  S.saving = false;
  if (error) {
    updateSaveState();
    return toast(`Save failed: ${error.message}`, true);
  }
  S.dirty.clear();
  toast(unanswered ? `Saved (${unanswered} answer${unanswered > 1 ? 's' : ''} cleared)` : `Saved ${payload.length} answer${payload.length > 1 ? 's' : ''}`);

  await Promise.all([loadQueue(), loadProgress(), refreshVillageCounts()]).catch((e) => toast(e.message, true));
  if (next && nextRow) openRow(nextRow);
  else {
    if (next) toast('End of the queue');
    await selectUnit({ tp: u.treatment_plot?.row.plot_id, cp: u.control_plot?.row.plot_id, unitId: S.activeUnitId }, { noZoom: true, force: true });
  }
}

function nextQueueRow() {
  const list = S.filtered;
  if (!list.length) return null;
  const i = list.findIndex((r) => r.unit_id === S.activeUnitId);
  return i === -1 ? list[0] : list[i + 1] || null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const ANSWER_COLUMNS = 'pre_sample_valid,eoy_sample_valid,snake_visible';
// Sample sheets are exported in their original column order, followed by the answer columns
const EXPORTS = {
  treatment_samples: { order: 'plot_id', columns: `deployment_id,plot_id,village_name,farmer_id,farmer_name,crusher_code,deployment_ids,n_deployments,pre,pre_location,eoy,eoy_location,${ANSWER_COLUMNS}` },
  control_samples: { order: 'control_plot_id', columns: `deployment_id,control_plot_id,village_name,farmer_name,pre_ids,eoy_ids,control_pre_location,control_eoy_location,${ANSWER_COLUMNS}` },
  v_samples: { order: 'record_id', columns: '*' },
  v_review_queue: { order: 'unit_id', columns: '*' },
};

async function exportTable(name) {
  const spec = EXPORTS[name];
  toast(`Exporting ${name}…`);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await S.sb.from(name).select(spec.columns).order(spec.order, { ascending: true }).range(from, from + 999);
    if (error) return toast(error.message, true);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  if (!rows.length) return toast('Nothing to export yet');
  const cols = spec.columns === '*' ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : spec.columns.split(',');
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${rows.length} rows`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtM2(v) {
  return `${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`;
}
function fmtTime(v) {
  return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function ids(list, n = 4) {
  if (!list || !list.length) return '–';
  return list.slice(0, n).join(', ') + (list.length > n ? ` +${list.length - n} more` : '');
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 6000 : 2500);
}
