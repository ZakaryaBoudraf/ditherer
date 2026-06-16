/* ============================================================================
   Ditherer — image processing engine
   Pure client-side. Exposes a global `Dither` object.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- small helpers --------------------------------------------- */
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  /* ---------- error-diffusion kernels ----------------------------------- */
  /* each kernel entry is [dx, dy, weight]; only forward neighbours */
  const KERNELS = {
    'floyd-steinberg': { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    'false-floyd-steinberg': { div: 8, k: [[1, 0, 3], [0, 1, 3], [1, 1, 2]] },
    'jarvis': {
      div: 48,
      k: [[1, 0, 7], [2, 0, 5],
          [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
          [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
    },
    'stucki': {
      div: 42,
      k: [[1, 0, 8], [2, 0, 4],
          [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
          [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
    },
    'atkinson': { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
    'burkes': {
      div: 32,
      k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
    },
    'sierra': {
      div: 32,
      k: [[1, 0, 5], [2, 0, 3],
          [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
          [-1, 2, 2], [0, 2, 3], [1, 2, 2]],
    },
    'two-row-sierra': {
      div: 16,
      k: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]],
    },
    'sierra-lite': { div: 4, k: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
    'stevenson-arce': {
      div: 200,
      k: [[2, 0, 32],
          [-3, 1, 12], [-1, 1, 26], [1, 1, 30], [3, 1, 16],
          [-2, 2, 12], [0, 2, 26], [2, 2, 12],
          [-3, 3, 5], [-1, 3, 12], [1, 3, 12], [3, 3, 5]],
    },
  };

  /* ---------- ordered (threshold) matrices ------------------------------ */
  function bayer(n) {
    if (n === 1) return [[0]];
    const half = bayer(n >> 1);
    const s = half.length;
    const m = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = half[y][x] * 4;
        m[y][x] = v + 0;
        m[y][x + s] = v + 2;
        m[y + s][x] = v + 3;
        m[y + s][x + s] = v + 1;
      }
    }
    return m;
  }
  // normalise an integer matrix of values 0..(n*n-1) to floats in (0,1)
  function normMatrix(m) {
    const n = m.length;
    const denom = n * n;
    return m.map((row) => row.map((v) => (v + 0.5) / denom));
  }

  const MATRICES = {
    bayer2: normMatrix(bayer(2)),
    bayer4: normMatrix(bayer(4)),
    bayer8: normMatrix(bayer(8)),
    // a classic clustered-dot screen (halftone-like ordered pattern)
    clustered4: normMatrix([
      [12, 5, 6, 13],
      [4, 0, 1, 7],
      [11, 3, 2, 8],
      [15, 10, 9, 14],
    ]),
    // 45-degree dotted cluster (8x8)
    clustered8: normMatrix([
      [24, 10, 12, 26, 35, 47, 49, 37],
      [8, 0, 2, 14, 45, 59, 61, 51],
      [22, 6, 4, 16, 43, 57, 63, 53],
      [30, 20, 18, 28, 33, 41, 55, 39],
      [34, 46, 48, 36, 25, 11, 13, 27],
      [44, 58, 60, 50, 9, 1, 3, 15],
      [42, 56, 62, 52, 23, 7, 5, 17],
      [32, 40, 54, 38, 31, 21, 19, 29],
    ]),
  };

  /* ---------- algorithm registry (drives the UI) ------------------------ */
  const ALGORITHMS = {
    'floyd-steinberg': { label: 'Floyd–Steinberg', group: 'Error diffusion', type: 'error' },
    'false-floyd-steinberg': { label: 'False Floyd–Steinberg', group: 'Error diffusion', type: 'error' },
    'jarvis': { label: 'Jarvis–Judice–Ninke', group: 'Error diffusion', type: 'error' },
    'stucki': { label: 'Stucki', group: 'Error diffusion', type: 'error' },
    'atkinson': { label: 'Atkinson', group: 'Error diffusion', type: 'error' },
    'burkes': { label: 'Burkes', group: 'Error diffusion', type: 'error' },
    'sierra': { label: 'Sierra (3 row)', group: 'Error diffusion', type: 'error' },
    'two-row-sierra': { label: 'Two-Row Sierra', group: 'Error diffusion', type: 'error' },
    'sierra-lite': { label: 'Sierra Lite', group: 'Error diffusion', type: 'error' },
    'stevenson-arce': { label: 'Stevenson–Arce', group: 'Error diffusion', type: 'error' },

    bayer2: { label: 'Bayer 2×2', group: 'Ordered', type: 'ordered', matrix: MATRICES.bayer2 },
    bayer4: { label: 'Bayer 4×4', group: 'Ordered', type: 'ordered', matrix: MATRICES.bayer4 },
    bayer8: { label: 'Bayer 8×8', group: 'Ordered', type: 'ordered', matrix: MATRICES.bayer8 },
    clustered4: { label: 'Clustered 4×4', group: 'Ordered', type: 'ordered', matrix: MATRICES.clustered4 },
    clustered8: { label: 'Clustered 8×8', group: 'Ordered', type: 'ordered', matrix: MATRICES.clustered8 },

    halftone: { label: 'Halftone dots', group: 'Pattern', type: 'halftone' },
    random: { label: 'Random noise', group: 'Pattern', type: 'random' },
    threshold: { label: 'Threshold (no dither)', group: 'Pattern', type: 'threshold' },
  };

  /* ---------- colour-space conversions ---------------------------------- */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return [h, s, l];
  }
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function hslToRgb(h, s, l) {
    h /= 360;
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [r * 255, g * 255, b * 255];
  }

  /* ---------- pre-dither adjustments ------------------------------------ */
  function applyAdjustments(imageData, s) {
    const d = imageData.data;

    // build a brightness/contrast/midtones/invert LUT (per 0..255 channel)
    const bright = s.brightness * 1.5;                  // -150 .. 150
    const c = s.contrast * 2.55;                        // -255 .. 255
    const cf = (259 * (c + 255)) / (255 * (259 - c));   // contrast factor
    const gammaExp = Math.pow(3, -s.midtones / 100);    // 0=neutral
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = i + bright;
      v = cf * (v - 128) + 128;
      v = clamp(v);
      v = 255 * Math.pow(v / 255, gammaExp);
      v = clamp(v);
      if (s.invert) v = 255 - v;
      lut[i] = v;
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }

    // hue / saturation (only if non-default — it's the expensive path)
    if (s.saturation !== 0 || s.hue !== 0) {
      const satMul = 1 + s.saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        const hsl = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        let h = hsl[0] + s.hue;
        h = ((h % 360) + 360) % 360;
        const sat = Math.min(1, Math.max(0, hsl[1] * satMul));
        const rgb = hslToRgb(h, sat, hsl[2]);
        d[i] = clamp(rgb[0]);
        d[i + 1] = clamp(rgb[1]);
        d[i + 2] = clamp(rgb[2]);
      }
    }
    return imageData;
  }

  /* ---------- palette helpers ------------------------------------------- */
  // nearest palette colour by perceptually-weighted squared distance
  function nearest(palette, r, g, b) {
    let best = palette[0], bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const dist = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
      if (dist < bd) { bd = dist; best = p; }
    }
    return best;
  }

  // median-cut palette extraction from an ImageData
  function extractPalette(imageData, count) {
    const data = imageData.data;
    const total = data.length / 4;
    const step = Math.max(1, Math.floor(total / 12000));
    const pixels = [];
    for (let i = 0; i < data.length; i += 4 * step) {
      if (data[i + 3] < 8) continue;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (pixels.length === 0) return [[0, 0, 0], [255, 255, 255]];
    let boxes = [pixels];
    while (boxes.length < count) {
      let bi = -1, brange = -1, bch = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.length < 2) continue;
        const mn = [255, 255, 255], mx = [0, 0, 0];
        for (const p of box) {
          for (let c = 0; c < 3; c++) {
            if (p[c] < mn[c]) mn[c] = p[c];
            if (p[c] > mx[c]) mx[c] = p[c];
          }
        }
        for (let c = 0; c < 3; c++) {
          const r = mx[c] - mn[c];
          if (r > brange) { brange = r; bi = i; bch = c; }
        }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      box.sort((a, b) => a[bch] - b[bch]);
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.map((box) => {
      const sum = [0, 0, 0];
      for (const p of box) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; }
      return [Math.round(sum[0] / box.length), Math.round(sum[1] / box.length), Math.round(sum[2] / box.length)];
    });
  }

  /* ---------- dithering core paths -------------------------------------- */
  function blankOutput(w, h) {
    const out = new ImageData(w, h);
    return out;
  }

  function errorDiffuse(src, od, w, h, palette, kernel, div, strength, serpentine) {
    const n = w * h;
    const rf = new Float32Array(n), gf = new Float32Array(n), bf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rf[i] = src[i * 4]; gf[i] = src[i * 4 + 1]; bf[i] = src[i * 4 + 2];
    }
    const str = strength / 100;
    for (let y = 0; y < h; y++) {
      const ltr = !serpentine || (y & 1) === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const idx = y * w + x;
        const or = rf[idx], og = gf[idx], ob = bf[idx];
        const nc = nearest(palette, clamp(or), clamp(og), clamp(ob));
        const o4 = idx * 4;
        od[o4] = nc[0]; od[o4 + 1] = nc[1]; od[o4 + 2] = nc[2]; od[o4 + 3] = 255;
        const er = (or - nc[0]) * str, eg = (og - nc[1]) * str, eb = (ob - nc[2]) * str;
        for (let t = 0; t < kernel.length; t++) {
          const dx = kernel[t][0], dy = kernel[t][1];
          const sx = ltr ? x + dx : x - dx;
          const sy = y + dy;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const f = kernel[t][2] / div;
          const ni = sy * w + sx;
          rf[ni] += er * f; gf[ni] += eg * f; bf[ni] += eb * f;
        }
      }
    }
  }

  function orderedDither(src, od, w, h, palette, matrix, amp, phase) {
    const n = matrix.length;
    const ph = phase | 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (matrix[(y + ph) % n][(x + ph) % n] - 0.5) * amp;
        const i = (y * w + x) * 4;
        const nc = nearest(palette, clamp(src[i] + t), clamp(src[i + 1] + t), clamp(src[i + 2] + t));
        od[i] = nc[0]; od[i + 1] = nc[1]; od[i + 2] = nc[2]; od[i + 3] = 255;
      }
    }
  }

  function randomDither(src, od, w, h, palette, amp) {
    for (let i = 0; i < src.length; i += 4) {
      const t = (Math.random() - 0.5) * amp;
      const nc = nearest(palette, clamp(src[i] + t), clamp(src[i + 1] + t), clamp(src[i + 2] + t));
      od[i] = nc[0]; od[i + 1] = nc[1]; od[i + 2] = nc[2]; od[i + 3] = 255;
    }
  }

  function thresholdDither(src, od, palette) {
    for (let i = 0; i < src.length; i += 4) {
      const nc = nearest(palette, src[i], src[i + 1], src[i + 2]);
      od[i] = nc[0]; od[i + 1] = nc[1]; od[i + 2] = nc[2]; od[i + 3] = 255;
    }
  }

  function halftoneDither(src, od, w, h, palette, cell) {
    const cs = Math.max(2, cell | 0);
    const cols = Math.ceil(w / cs), rows = Math.ceil(h / cs);
    const sum = new Float32Array(cols * rows);
    const cnt = new Int32Array(cols * rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const ci = (Math.floor(y / cs)) * cols + Math.floor(x / cs);
        sum[ci] += lum(src[i], src[i + 1], src[i + 2]);
        cnt[ci]++;
      }
    }
    // pick darkest = ink, lightest = paper from the palette
    let fg = palette[0], bg = palette[0], fl = Infinity, bl = -Infinity;
    for (const p of palette) {
      const L = lum(p[0], p[1], p[2]);
      if (L < fl) { fl = L; fg = p; }
      if (L > bl) { bl = L; bg = p; }
    }
    const rMax = cs * 0.5 * Math.SQRT2;
    for (let y = 0; y < h; y++) {
      const cy = Math.floor(y / cs);
      for (let x = 0; x < w; x++) {
        const cx = Math.floor(x / cs);
        const ci = cy * cols + cx;
        const avg = sum[ci] / cnt[ci];
        const radius = (1 - avg / 255) * rMax;
        const dx = x - (cx * cs + cs / 2);
        const dy = y - (cy * cs + cs / 2);
        const inside = dx * dx + dy * dy <= radius * radius;
        const c = inside ? fg : bg;
        const i = (y * w + x) * 4;
        od[i] = c[0]; od[i + 1] = c[1]; od[i + 2] = c[2]; od[i + 3] = 255;
      }
    }
  }

  /* ---------- public dither dispatcher ---------------------------------- */
  function dither(imageData, palette, s) {
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = blankOutput(w, h);
    const od = out.data;
    const algo = ALGORITHMS[s.algorithm] || ALGORITHMS['floyd-steinberg'];

    if (algo.type === 'error') {
      const kr = KERNELS[s.algorithm];
      errorDiffuse(src, od, w, h, palette, kr.k, kr.div, s.amount, s.serpentine);
    } else if (algo.type === 'ordered') {
      orderedDither(src, od, w, h, palette, algo.matrix, s.step * (s.amount / 100), s.phase | 0);
    } else if (algo.type === 'random') {
      randomDither(src, od, w, h, palette, s.step * (s.amount / 100));
    } else if (algo.type === 'halftone') {
      halftoneDither(src, od, w, h, palette, s.halftoneSize);
    } else {
      thresholdDither(src, od, palette);
    }
    return out;
  }

  /* ---------- O(n) separable box blur (for glow) ------------------------ */
  function blurH(src, dst, w, h, r) {
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = acc * norm;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
  }
  function blurV(src, dst, w, h, r) {
    const norm = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc * norm;
        acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
      }
    }
  }
  function boxBlur(buf, scratch, w, h, r) {
    blurH(buf, scratch, w, h, r);
    blurV(scratch, buf, w, h, r);
  }
  const screen = (a, b) => 255 - (255 - a) * (255 - b) / 255;

  /* ---------- post-dither effects --------------------------------------- */
  function applyPostEffects(id, s) {
    const w = id.width, h = id.height, d = id.data;

    // --- signal: analog wave warp + horizontal light-trail bleed ---------
    if (s.signal > 0) {
      const amt = s.signal / 100;
      const amp = amt * w * 0.04;
      if (amp >= 0.5) {                          // (A) wobble each row sideways
        const src = d.slice();
        const f1 = (Math.PI * 2) * (2 + amt * 4) / h;
        const f2 = (Math.PI * 2) * 0.7 / h;
        for (let y = 0; y < h; y++) {
          const dx = Math.round((Math.sin(y * f1) * 0.7 + Math.sin(y * f2 + 1.3) * 0.3) * amp);
          for (let x = 0; x < w; x++) {
            let sx = x - dx; if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
            const o = (y * w + x) * 4, p = (y * w + sx) * 4;
            d[o] = src[p]; d[o + 1] = src[p + 1]; d[o + 2] = src[p + 2];
          }
        }
      }
      const decay = 0.78 + amt * 0.2;            // (B) bright pixels trail rightward
      const m = amt * 0.85;
      for (let y = 0; y < h; y++) {
        let tr = 0, tg = 0, tb = 0;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          tr *= decay; tg *= decay; tb *= decay;
          if (d[i] > tr) tr = d[i];
          if (d[i + 1] > tg) tg = d[i + 1];
          if (d[i + 2] > tb) tb = d[i + 2];
          d[i] = screen(d[i], tr * m);
          d[i + 1] = screen(d[i + 1], tg * m);
          d[i + 2] = screen(d[i + 2], tb * m);
        }
      }
    }

    if (s.chroma > 0) {
      const off = Math.max(1, Math.round(s.chroma));
      const copy = d.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const rx = Math.min(w - 1, x + off);
          const bx = Math.max(0, x - off);
          d[i] = copy[(y * w + rx) * 4];         // red sampled to the right
          d[i + 2] = copy[(y * w + bx) * 4 + 2]; // blue sampled to the left
        }
      }
    }
    // --- glow / bloom: soft halo around bright pixels --------------------
    if (s.glow > 0) {
      const amt = s.glow / 100;
      const n = w * h;
      const br = new Float32Array(n), bg = new Float32Array(n), bb = new Float32Array(n);
      const scratch = new Float32Array(n);
      const thr = 110;                           // only bright pixels bloom
      for (let i = 0; i < n; i++) {
        const o = i * 4, L = lum(d[o], d[o + 1], d[o + 2]);
        const k = L > thr ? (L - thr) / (255 - thr) : 0;
        br[i] = d[o] * k; bg[i] = d[o + 1] * k; bb[i] = d[o + 2] * k;
      }
      const radius = Math.max(1, Math.round(amt * Math.max(w, h) * 0.04));
      for (let pass = 0; pass < 2; pass++) {     // two box passes ≈ Gaussian
        boxBlur(br, scratch, w, h, radius);
        boxBlur(bg, scratch, w, h, radius);
        boxBlur(bb, scratch, w, h, radius);
      }
      const gain = 0.6 + amt * 1.9;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        d[o] = screen(d[o], Math.min(255, br[i] * gain));
        d[o + 1] = screen(d[o + 1], Math.min(255, bg[i] * gain));
        d[o + 2] = screen(d[o + 2], Math.min(255, bb[i] * gain));
      }
    }

    if (s.noise > 0) {
      const amt = s.noise * 2;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * amt;
        d[i] = clamp(d[i] + n);
        d[i + 1] = clamp(d[i + 1] + n);
        d[i + 2] = clamp(d[i + 2] + n);
      }
    }
    if (s.scanlines > 0) {
      const k = s.scanlines / 100;
      for (let y = 1; y < h; y += 2) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          d[i] *= 1 - k; d[i + 1] *= 1 - k; d[i + 2] *= 1 - k;
        }
      }
    }
    return id;
  }

  /* ---------- exports ---------------------------------------------------- */
  global.Dither = {
    ALGORITHMS,
    applyAdjustments,
    dither,
    applyPostEffects,
    extractPalette,
    nearest,
    luminance: lum,
  };
})(window);
