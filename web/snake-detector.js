// Snake-pattern detector for Esri World Imagery.
//
// Looks for long, curving dark strokes (the serpentine spreading trail) inside a
// plot outline. Straight strokes (field edges, roads) and tree crowns are ignored.
// Tuned by hand on 52 Seoni plots labelled by eye (zoom 18, ~0.6 m/px): with these
// defaults it found 6 of 7 snake plots, with 5 false alarms in 41 plain plots
// (textured crops, ploughing, scattered trees). Treat the verdict as a pointer for
// the reviewer, not ground truth; recalibrate once reviewers have answered more plots.
//
// Pure JS core (detectSnakeInPixels) + a browser wrapper that fetches Esri tiles
// (detectSnakeOnEsri). No dependencies.
(function (root) {
  'use strict';

  const ESRI_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ZOOM = 18;
  const PAD = 12; // px of context around the plot

  const PARAMS = {
    blur: 0.8,        // light smoothing before analysis (px)
    strokeRadius: 4,  // dark features narrower than ~2r+1 px (~5 m) count as strokes
    relDark: 0.08,    // how much darker than the surroundings a stroke must be (fraction)
    treeMode: 'wide', // 'wide': trees = wide dark patches (any colour); 'green': green + dark
    treeExg: 0.03,    // ('green' mode) greenness above which dark areas are treated as tree crowns
    treeDark: 0.05,   // ...at least this much darker than the plot's median brightness
    treeWidth: 5,     // only dark patches wider than ~2x this many px (~6 m) count as trees
    treeGrow: 2,      // strokes within this many px of a tree crown are dropped (crown edges)
    edgeBuffer: -2,   // stay this many px inside the outline (-) or look beyond it (+)
    gap: 2,           // join stroke pieces separated by up to this many px
    minLen: 15,       // ignore strokes shorter than this (px, ~9 m)
    yesLen: 30,       // total length of curving strokes (px) needed for "yes"
    cloudBright: 0.55 // mean brightness above this = cloud / haze, verdict "unclear"
  };

  // ---------------------------------------------------------------- helpers
  function gaussianKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return { k, r };
  }

  function blur(src, w, h, sigma) {
    const { k, r } = gaussianKernel(sigma);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
        tmp[y * w + x] = s;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
        out[y * w + x] = s;
      }
    return out;
  }

  function diskOffsets(r) {
    const o = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) o.push([dx, dy]);
    return o;
  }

  // grey-level max / min filter over a disk (edges clamp)
  function greyFilter(src, w, h, offs, isMax) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = isMax ? -Infinity : Infinity;
        for (const [dx, dy] of offs) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const p = src[yy * w + xx];
          if (isMax ? p > v : p < v) v = p;
        }
        out[y * w + x] = v;
      }
    return out;
  }

  // binary erode / dilate with a list of offsets (outside the image counts as 0)
  function binMorph(src, w, h, offs, erode) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let hit = erode ? 1 : 0;
        for (const [dx, dy] of offs) {
          const xx = x + dx, yy = y + dy;
          const p = xx >= 0 && yy >= 0 && xx < w && yy < h ? src[yy * w + xx] : 0;
          if (erode && !p) { hit = 0; break; }
          if (!erode && p) { hit = 1; break; }
        }
        out[y * w + x] = hit;
      }
    return out;
  }
  const CROSS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const SQUARE2 = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const SQUARE2_BACK = [[0, 0], [-1, 0], [0, -1], [-1, -1]];
  function repeat(fn, src, n) { let a = src; for (let i = 0; i < n; i++) a = fn(a); return a; }

  // Zhang-Suen thinning -> 1 px wide centre lines
  function skeletonize(src, w, h) {
    const img = Uint8Array.from(src);
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? img[y * w + x] : 0);
    let changed = true;
    while (changed) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        const del = [];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (!img[y * w + x]) continue;
            const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
            const b = p.reduce((a, c) => a + c, 0);
            if (b < 2 || b > 6) continue;
            let a = 0;
            for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
            if (a !== 1) continue;
            if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
            del.push(y * w + x);
          }
        for (const i of del) img[i] = 0;
        if (del.length) changed = true;
      }
    }
    return img;
  }

  function pointInRings(x, y, rings) {
    let inside = false;
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    return inside;
  }

  // ---------------------------------------------------------------- core
  // rgba: Uint8ClampedArray (w*h*4); rings: polygon rings in pixel coordinates.
  function detectSnakeInPixels(rgba, w, h, rings, params) {
    const P = Object.assign({}, PARAMS, params);
    const n = w * h;
    const gray = new Float32Array(n), exg = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rgba[4 * i] / 255, g = rgba[4 * i + 1] / 255, b = rgba[4 * i + 2] / 255;
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      exg[i] = 2 * g - r - b;
    }

    const mask = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = pointInRings(x + 0.5, y + 0.5, rings) ? 1 : 0;
    const inner = P.edgeBuffer >= 0
      ? repeat((a) => binMorph(a, w, h, CROSS, false), mask, P.edgeBuffer)
      : repeat((a) => binMorph(a, w, h, CROSS, true), mask, -P.edgeBuffer);
    const area = inner.reduce((a, c) => a + c, 0);
    if (area < 20) return { verdict: 'unclear', reason: 'Plot too small at this zoom', score: 0, area };

    const g = blur(gray, w, h, P.blur);
    const inPlot = [];
    for (let i = 0; i < n; i++) if (mask[i]) inPlot.push(g[i]);
    inPlot.sort((a, b) => a - b);
    const median = inPlot[Math.floor(inPlot.length / 2)];
    const meanBright = inPlot.reduce((a, c) => a + c, 0) / inPlot.length;
    if (meanBright > P.cloudBright) {
      return { verdict: 'unclear', reason: 'Imagery looks cloudy or hazy over this plot', score: 0, area };
    }

    // dark strokes: darker than a disk-closing of the image (which fills narrow dark features)
    const disk = diskOffsets(P.strokeRadius);
    const closed = greyFilter(greyFilter(g, w, h, disk, true), w, h, disk, false);
    let stroke = new Uint8Array(n);
    for (let i = 0; i < n; i++) stroke[i] = (closed[i] - g[i]) / (closed[i] + 0.05) > P.relDark ? 1 : 0;
    stroke = binMorph(binMorph(stroke, w, h, SQUARE2, true), w, h, SQUARE2_BACK, false);

    // tree crowns: dark patches too wide to be a spreading trail (trails can be green too,
    // where crops regrow in them, so width is what separates them); drop strokes on or
    // next to them, since crown edges look like short dark strokes
    const exgB = blur(exg, w, h, 1.5), g2 = blur(gray, w, h, 2);
    let tree = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dark = g2[i] < median - P.treeDark;
      tree[i] = (P.treeMode === 'green' ? dark && exgB[i] > P.treeExg : dark) ? 1 : 0;
    }
    tree = repeat((a) => binMorph(a, w, h, CROSS, true), tree, P.treeWidth);
    tree = repeat((a) => binMorph(a, w, h, CROSS, false), tree, P.treeWidth);
    tree = repeat((a) => binMorph(a, w, h, CROSS, false), tree, P.treeGrow);
    for (let i = 0; i < n; i++) if (tree[i]) stroke[i] = 0;

    if (P.gap) {
      const d = diskOffsets(P.gap);
      stroke = binMorph(binMorph(stroke, w, h, d, false), w, h, d, true);
    }

    const sk = skeletonize(stroke, w, h);
    for (let i = 0; i < n; i++) if (!inner[i]) sk[i] = 0;

    // connected centre lines; keep the long ones that bend
    const seen = new Uint8Array(n);
    let total = 0, longest = 0, count = 0;
    for (let s = 0; s < n; s++) {
      if (!sk[s] || seen[s]) continue;
      const pts = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p / w) | 0;
        pts.push([x, y]);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (sk[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
          }
      }
      const L = pts.length;
      if (L < P.minLen) continue;
      let mx = 0, my = 0;
      for (const [x, y] of pts) { mx += x; my += y; }
      mx /= L; my /= L;
      let sxx = 0, syy = 0, sxy = 0;
      for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
      sxx /= L - 1; syy /= L - 1; sxy /= L - 1;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const big = tr / 2 + disc, small = Math.max(0, tr / 2 - disc);
      const curv = L / (4 * Math.sqrt(Math.max(big, 1e-6))); // 1 = straight, >1 = bends
      const bend = Math.sqrt(small / Math.max(big, 1e-6));    // 0 = straight, 1 = looping
      if (bend > 0.25 || curv > 1.35) { total += L; longest = Math.max(longest, L); count++; }
    }

    const metres = (px) => Math.round(px * 0.6);
    const verdict = total >= P.yesLen ? 'yes' : 'no';
    const reason = count
      ? `${count} curving stroke${count > 1 ? 's' : ''}, ~${metres(total)} m in total (longest ~${metres(longest)} m)`
      : 'No long curving strokes inside the plot';
    return { verdict, reason, score: total, longest, strokes: count, area };
  }

  // ---------------------------------------------------------------- browser wrapper
  function lonLatToPx(lon, lat, z) {
    const size = 256 * 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
  }
  function ringsOf(geom) {
    return geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
  }
  const tileCache = new Map();
  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!tileCache.has(key)) {
      const url = ESRI_TILE.replace('{z}', z).replace('{y}', y).replace('{x}', x);
      tileCache.set(key, fetch(url, { mode: 'cors' }).then((r) => {
        if (!r.ok) throw new Error(`Esri tile ${key}: HTTP ${r.status}`);
        return r.blob();
      }).then((b) => createImageBitmap(b)));
    }
    return tileCache.get(key);
  }

  // geometry: GeoJSON Polygon / MultiPolygon in lon/lat
  async function detectSnakeOnEsri(geometry, params) {
    const rings = ringsOf(geometry);
    if (!rings.length) return { verdict: 'unclear', reason: 'No plot outline', score: 0 };
    const pts = rings.flat().map(([lon, lat]) => lonLatToPx(lon, lat, ZOOM));
    const x0 = Math.floor(Math.min(...pts.map((p) => p[0])) - PAD), x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) + PAD);
    const y0 = Math.floor(Math.min(...pts.map((p) => p[1])) - PAD), y1 = Math.ceil(Math.max(...pts.map((p) => p[1])) + PAD);
    const w = x1 - x0, h = y1 - y0;
    if (w * h > 600 * 600) return { verdict: 'unclear', reason: 'Plot too large to analyse in the browser', score: 0 };

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tiles = [];
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++)
      for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++)
        tiles.push(loadTile(ZOOM, tx, ty).then((bmp) => ctx.drawImage(bmp, tx * 256 - x0, ty * 256 - y0)));
    await Promise.all(tiles);
    const { data } = ctx.getImageData(0, 0, w, h);
    const pxRings = rings.map((r) => r.map(([lon, lat]) => {
      const [x, y] = lonLatToPx(lon, lat, ZOOM);
      return [x - x0, y - y0];
    }));
    // Esri serves a flat grey "Map data not yet available" tile where it has no imagery
    let grey = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === data[i + 1] && data[i + 1] === data[i + 2] && data[i] > 190) grey++;
    if (grey > 0.8 * w * h) return { verdict: 'unclear', reason: 'Esri has no imagery here at this zoom', score: 0 };
    return detectSnakeInPixels(data, w, h, pxRings, params);
  }

  root.SnakeDetector = { detectSnakeInPixels, detectSnakeOnEsri, PARAMS };
  if (typeof module !== 'undefined') module.exports = root.SnakeDetector;
})(typeof window !== 'undefined' ? window : globalThis);
