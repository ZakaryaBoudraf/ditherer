/* ============================================================================
   Ditherer — UI + pipeline orchestration
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const tick = () => new Promise((r) => setTimeout(r));
  // await an event; optional timeout so a missing event can't hang an export
  const once = (el, evt, timeoutMs) => new Promise((res) => {
    let t = null;
    const h = () => { if (t) clearTimeout(t); res(); };
    el.addEventListener(evt, h, { once: true });
    if (timeoutMs) t = setTimeout(() => { el.removeEventListener(evt, h); res(); }, timeoutMs);
  });
  const fmtTime = (sec) => {
    if (!isFinite(sec)) return '–:––';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  };
  const fmtSize = (bytes) => bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : Math.max(1, Math.round(bytes / 1024)) + ' KB';

  const MAX_GIF_FRAMES = 200; // cap for video → GIF sampling

  /* ---------- preset palettes ------------------------------------------- */
  // "AABBCC DDEEFF …" → [[r,g,b], …]
  const HEX = (str) => str.trim().split(/\s+/).map((h) =>
    [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);

  const PALETTES = {
    'bw': { name: 'Black & White', colors: HEX('000000 FFFFFF') },
    'gameboy': { name: 'Game Boy (DMG)', colors: HEX('0F380F 306230 8BAC0F 9BBC0F') },
    'gameboy-pocket': { name: 'Game Boy Pocket', colors: HEX('081820 346856 88C070 E0F8D0') },
    'nes': {
      name: 'NES (8-bit)',
      colors: HEX(
        '7C7C7C 0000FC 0000BC 4428BC 940084 A80020 A81000 881400 503000 007800 006800 005800 004058 000000 ' +
        'BCBCBC 0078F8 0058F8 6844FC D800CC E40058 F83800 E45C10 AC7C00 00B800 00A800 00A844 008888 080808 ' +
        'F8F8F8 3CBCFC 6888FC 9878F8 F878F8 F85898 F87858 FCA044 F8B800 B8F818 58D854 58F898 00E8D8 787878 ' +
        'FCFCFC A4E4FC B8B8F8 D8B8F8 F8B8F8 F8A4C0 F0D0B0 FCE0A8 F8D878 D8F878 B8F8B8 B8F8D8 00FCFC F8D8F8'),
    },
    'ega': {
      name: 'EGA / VGA 16 (8-bit PC)',
      colors: HEX('000000 0000AA 00AA00 00AAAA AA0000 AA00AA AA5500 AAAAAA 555555 5555FF 55FF55 55FFFF FF5555 FF55FF FFFF55 FFFFFF'),
    },
    'cga': { name: 'CGA (cyan/magenta)', colors: HEX('000000 55FFFF FF55FF FFFFFF') },
    'cga-yellow': { name: 'CGA (red/green/yellow)', colors: HEX('000000 55FF55 FF5555 FFFF55') },
    'apple2': { name: 'Apple II hi-res', colors: HEX('000000 14F53C FF44FD FF6A3C 14CFFD FFFFFF') },
    'msx': {
      name: 'MSX (TMS9918)',
      colors: HEX('000000 3EB849 74D07D 5955E0 8076F1 B95E51 65DBEF DB6559 FF897D CCC35E DED087 3AA241 B766B5 CCCCCC FFFFFF'),
    },
    'cpc': { name: 'Amstrad CPC (27)', colors: [] }, // filled below
    'zx': { name: 'ZX Spectrum', colors: HEX('000000 0000D7 D70000 D700D7 00D700 00D7D7 D7D700 FFFFFF') },
    'c64': {
      name: 'Commodore 64',
      colors: HEX('000000 FFFFFF 883932 67B6BD 8B3F96 55A049 40318D BFCE72 8B5429 574200 B86962 505050 787878 94E089 7869C4 9F9F9F'),
    },
    'amiga-wb': { name: 'Amiga Workbench (16-bit)', colors: HEX('0055AA FFFFFF 000000 FF8800') },
    'pico8': {
      name: 'PICO-8',
      colors: HEX('000000 1D2B53 7E2553 008751 AB5236 5F574F C2C3C7 FFF1E8 FF004D FFA300 FFEC27 00E436 29ADFF 83769C FF77A8 FFCCAA'),
    },
    'cmyk': { name: 'CMYK', colors: HEX('000000 00AEEF EC008C FFF200 FFFFFF') },
    'sepia': { name: 'Sepia', colors: HEX('2C1910 6C432C AD7A4F E8C598 FFF5DE') },
  };
  // Amstrad CPC: all 27 combinations of three RGB levels
  for (const r of [0, 128, 255]) for (const g of [0, 128, 255]) for (const b of [0, 128, 255]) {
    PALETTES.cpc.colors.push([r, g, b]);
  }

  /* ---------- state ----------------------------------------------------- */
  const state = {
    image: null,          // current preview source: <img>, <canvas> (gif frame 0) or <video>
    gif: null,            // { width, height, frames:[{data,delayCs}] } when an animated GIF is loaded
    video: null,          // <video> element when a video is loaded
    videoUrl: null,       // object URL backing the video (revoked on replace)
    camera: null,         // { el:<video>, stream:MediaStream, mirror:bool } when live
    exporting: false,     // true during seek-based exports; pauses the live loop
    batch: [],            // queued File objects for batch processing
    customColors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179'],
    lastOutput: null,     // { w, h } of the last preview render
    // crop & straighten: angle in degrees, rot in quarter turns, ox/oy pan [0..1]
    transform: { angle: 0, rot: 0, ratio: 'free', zoom: 1, ox: 0.5, oy: 0.5 },
  };

  const DEFAULTS = {
    resolution: 500, algorithm: 'floyd-steinberg', mode: 'bw', palette: 'gameboy',
    ink: '#0b0b0d', paper: '#f2f2f2', animFrames: 12, animFps: 12,
  };
  const SLIDERS = ['resolution', 'brightness', 'contrast', 'midtones', 'saturation', 'hue',
                   'amount', 'halftoneSize', 'levels', 'extractCount', 'glow', 'signal', 'scanlines', 'noise', 'chroma',
                   'animFrames', 'animFps'];
  const ALL_DIALS = SLIDERS.concat(['straighten', 'cropZoom']);

  const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const rgbToHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

  /* ---------- read all settings ----------------------------------------- */
  function readSettings() {
    return {
      resolution: +$('resolution').value,
      brightness: +$('brightness').value,
      contrast: +$('contrast').value,
      midtones: +$('midtones').value,
      saturation: +$('saturation').value,
      hue: +$('hue').value,
      invert: $('invert').checked,
      algorithm: $('algorithm').value,
      amount: +$('amount').value,
      halftoneSize: +$('halftoneSize').value,
      serpentine: $('serpentine').checked,
      mode: $('mode').value,
      levels: +$('levels').value,
      palette: $('palette').value,
      ink: $('inkColor').value,
      paper: $('paperColor').value,
      glow: +$('glow').value,
      signal: +$('signal').value,
      scanlines: +$('scanlines').value,
      noise: +$('noise').value,
      chroma: +$('chroma').value,
      exportScale: +$('exportScale').value,
      outputSize: $('outputSize').value,
      outW: +$('outW').value,
      outH: +$('outH').value,
      fitMode: $('fitMode').value,
      fillColor: $('fillColor').value,
    };
  }

  // null for native output, else the target { W, H } in pixels
  function outputDims(s) {
    if (!s || s.outputSize === 'native') return null;
    let W, H;
    if (s.outputSize === 'custom') { W = Math.round(s.outW); H = Math.round(s.outH); }
    else { const m = String(s.outputSize).split('x'); W = +m[0]; H = +m[1]; }
    if (!(W >= 1 && H >= 1)) return null;
    return { W: Math.min(8192, W), H: Math.min(8192, H) };
  }

  // place dithered content (a canvas, w×h) into the final frame.
  // native: optionally upscale ×scale; fixed: contain/cover/stretch + fill bars.
  // pass opts.target to draw into an existing canvas (the live preview).
  function composeFramed(content, w, h, s, opts) {
    opts = opts || {};
    const dims = outputDims(s);
    if (!dims) {
      const scale = opts.scale || 1;
      if (!opts.target && scale === 1) return content;
      const c = opts.target || document.createElement('canvas');
      c.width = w * scale; c.height = h * scale;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.clearRect(0, 0, c.width, c.height);
      cx.drawImage(content, 0, 0, c.width, c.height);
      return c;
    }
    let W = dims.W, H = dims.H;
    if (opts.even) { W = Math.max(2, W - (W & 1)); H = Math.max(2, H - (H & 1)); }
    const c = opts.target || document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.fillStyle = /^#[0-9a-fA-F]{6}$/.test(s.fillColor) ? s.fillColor : '#000000';
    cx.fillRect(0, 0, W, H);
    let dw, dh;
    if (s.fitMode === 'stretch') { dw = W; dh = H; }
    else {
      const sc = (s.fitMode === 'cover') ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
      dw = Math.max(1, Math.round(w * sc)); dh = Math.max(1, Math.round(h * sc));
    }
    cx.drawImage(content, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
    return c;
  }

  /* ---------- build the working palette + dither "step" ----------------- */
  function buildPalette(s) {
    if (s.mode === 'bw') return { palette: [hexToRgb(s.ink), hexToRgb(s.paper)], step: 255 };
    if (s.mode === 'grayscale') {
      const a = hexToRgb(s.ink), b = hexToRgb(s.paper), n = Math.max(2, s.levels), pal = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        pal.push([
          Math.round(a[0] + (b[0] - a[0]) * t),
          Math.round(a[1] + (b[1] - a[1]) * t),
          Math.round(a[2] + (b[2] - a[2]) * t),
        ]);
      }
      return { palette: pal, step: 255 / (n - 1) };
    }
    let pal = s.palette === 'custom'
      ? state.customColors.map(hexToRgb)
      : (PALETTES[s.palette] || PALETTES.gameboy).colors.map((c) => c.slice());
    if (!pal.length) pal = [[0, 0, 0], [255, 255, 255]];
    return { palette: pal, step: 64 };
  }

  /* ---------- shared canvases ------------------------------------------- */
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const gifTmp = document.createElement('canvas');
  const gtctx = gifTmp.getContext('2d');
  const dcv = document.createElement('canvas');   // holds dithered content for the preview compose
  const dctx = dcv.getContext('2d');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  const srcDims = () => {
    const im = state.image;
    return [im.naturalWidth || im.videoWidth || im.width, im.naturalHeight || im.videoHeight || im.height];
  };
  const workingDims = (sw, sh, s) => {
    const scale = Math.min(1, s.resolution / Math.max(sw, sh));
    return [Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale))];
  };

  const parseRatio = (str) => {
    const m = String(str).split(':');
    return (+m[0]) / (+m[1]);
  };

  // Crop/straighten geometry. The crop is the largest axis-aligned rectangle of
  // the target aspect inscribed in the rotated source (so straightening never
  // exposes blank corners), shrunk by zoom and panned by ox/oy within the slack.
  // Returns null when the whole transform is a no-op.
  function cropParams(sw, sh) {
    const t = state.transform;
    const quarter = ((t.rot % 4) + 4) % 4;
    if (quarter === 0 && Math.abs(t.angle) < 0.005 && t.ratio === 'free' && t.zoom <= 1.001) return null;
    const theta = quarter * Math.PI / 2 + t.angle * Math.PI / 180;
    const si = Math.abs(Math.sin(theta)), co = Math.abs(Math.cos(theta));
    const a = t.ratio === 'free' ? ((quarter % 2) ? sh / sw : sw / sh) : parseRatio(t.ratio);
    const mw = Math.min(sw / (co + si / a), sh / (si + co / a));
    const mh = mw / a;
    const cw = mw / t.zoom, ch = mh / t.zoom;
    return {
      cw, ch, theta,
      px: (t.ox - 0.5) * (mw - cw),
      py: (t.oy - 0.5) * (mh - ch),
    };
  }

  function resetTransform() {
    state.transform = { angle: 0, rot: 0, ratio: 'free', zoom: 1, ox: 0.5, oy: 0.5 };
    $('cropRatio').value = 'free';
    $('straighten').value = 0;
    $('cropZoom').value = 1;
    canvas.style.cursor = '';
    syncOutputs();
  }

  /* ---------- the core: dither any drawable to an ImageData ------------- */
  // draws the (crop/straighten-transformed) source into the work canvas at
  // working resolution; returns [w, h]
  function drawSourceToWork(drawable, sw, sh, s) {
    const cp = cropParams(sw, sh);
    const [w, h] = workingDims(cp ? cp.cw : sw, cp ? cp.ch : sh, s);
    work.width = w; work.height = h;
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.clearRect(0, 0, w, h);
    wctx.fillStyle = '#ffffff';          // flatten transparency onto white
    wctx.fillRect(0, 0, w, h);
    const mirror = !!(state.camera && drawable === state.camera.el && state.camera.mirror);
    if (cp) {
      const kx = w / cp.cw, ky = h / cp.ch;
      wctx.save();
      wctx.translate(w / 2 - cp.px * kx, h / 2 - cp.py * ky);
      wctx.scale(kx, ky);
      wctx.rotate(cp.theta);
      if (mirror) wctx.scale(-1, 1);       // flip about the source centre
      wctx.drawImage(drawable, -sw / 2, -sh / 2, sw, sh);
      wctx.restore();
    } else if (mirror) {
      wctx.save();
      wctx.translate(w, 0);
      wctx.scale(-1, 1);
      wctx.drawImage(drawable, 0, 0, w, h);
      wctx.restore();
    } else {
      wctx.drawImage(drawable, 0, 0, w, h);
    }
    return [w, h];
  }

  // opts: { jitter:Number (animated grain), phase:Number (ordered-matrix offset) }
  function ditherSource(drawable, sw, sh, s, opts) {
    opts = opts || {};
    const [w, h] = drawSourceToWork(drawable, sw, sh, s);
    const id = wctx.getImageData(0, 0, w, h);
    Dither.applyAdjustments(id, s);
    if (opts.jitter) {
      const a = opts.jitter, d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * a;
        d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
      }
    }
    const bp = buildPalette(s);
    const ds = Object.assign({}, s, { step: bp.step, phase: opts.phase | 0 });
    const out = Dither.dither(id, bp.palette, ds);
    Dither.applyPostEffects(out, s);
    return { out, w, h };
  }

  /* ---------- fill colour + eyedropper ---------------------------------- */
  let eyedropping = false;
  function setFill(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
    $('fillColor').value = hex.toLowerCase();
    $('fillHex').value = hex.toUpperCase();
    return true;
  }
  function startEyedrop() {
    if (!state.image) return;
    eyedropping = true;
    canvas.classList.add('eyedrop');
    $('eyedropBtn').classList.add('active');
    $('eyedropBtn').textContent = '⌖ Click image';
  }
  function stopEyedrop() {
    eyedropping = false;
    canvas.classList.remove('eyedrop');
    $('eyedropBtn').classList.remove('active');
    $('eyedropBtn').textContent = '⌖ Pick';
  }
  function pickColorAt(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = Math.max(0, Math.min(canvas.width - 1, Math.floor((e.clientX - rect.left) / rect.width * canvas.width)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.floor((e.clientY - rect.top) / rect.height * canvas.height)));
    const d = ctx.getImageData(px, py, 1, 1).data;
    setFill(rgbToHex([d[0], d[1], d[2]]));
    stopEyedrop();
    schedule();
  }

  /* ---------- live preview ---------------------------------------------- */
  let pending = false;
  function schedule() {
    if (pending || state.exporting) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  }

  function render() {
    if (!state.image) return;
    const s = readSettings();
    const [sw, sh] = srcDims();

    if ($('showOriginal').checked) {
      const [w, h] = drawSourceToWork(state.image, sw, sh, s);
      composeFramed(work, w, h, s, { target: canvas });   // frame the raw source too
      state.lastOutput = { w, h };
      fitCanvas(canvas.width, canvas.height); updateStatus(s, sw, sh, w, h);
      return;
    }

    const { out, w, h } = ditherSource(state.image, sw, sh, s);
    dcv.width = w; dcv.height = h; dctx.putImageData(out, 0, 0);
    composeFramed(dcv, w, h, s, { target: canvas });
    state.lastOutput = { w, h };
    fitCanvas(canvas.width, canvas.height); updateStatus(s, sw, sh, w, h);
  }

  function updateStatus(s, sw, sh, w, h) {
    $('status').hidden = false;
    const dims = outputDims(s);
    const exW = dims ? canvas.width : w * s.exportScale;
    const exH = dims ? canvas.height : h * s.exportScale;
    const extra = state.camera ? ' · <b>LIVE</b> camera'
      : state.gif ? ` · <b>${state.gif.frames.length}</b> GIF frames`
      : state.video ? ` · <b>${fmtTime(state.video.duration)}</b> clip` : '';
    $('status').innerHTML = `<b>${sw}×${sh}</b> source · dithered at <b>${w}×${h}</b> · ` +
      `output <b>${exW}×${exH}</b>${extra}`;
  }

  function fitCanvas(w, h) {
    const stage = document.querySelector('.stage');
    const availW = stage.clientWidth - 56, availH = stage.clientHeight - 56;
    const fit = Math.min(availW / w, availH / h);
    const use = fit < 1 ? fit : Math.max(1, fit);
    canvas.style.width = Math.round(w * use) + 'px';
    canvas.style.height = Math.round(h * use) + 'px';
  }

  /* ---------- media loading ---------------------------------------------- */
  function loadImageFile(file) {
    if (!file) return;
    // a dropped preset file applies the settings instead of loading media
    if ((file.name && /\.json$/i.test(file.name)) || file.type === 'application/json') {
      importPresetFile(file);
      return;
    }
    if (file.type.startsWith('video/')) { loadVideoFile(file); return; }
    if (!file.type.startsWith('image/')) return;
    if (file.type === 'image/gif' && file.arrayBuffer) {
      file.arrayBuffer().then((buf) => {
        try {
          const gif = Codec.decodeGIF(buf);
          if (gif && gif.frames.length > 1) { setupGif(gif); return; }
        } catch (err) { console.warn('GIF decode failed, loading as still:', err); }
        loadAsImage(file);
      });
      return;
    }
    loadAsImage(file);
  }

  function onImageReady() {
    resetTransform();
    $('empty').hidden = true;
    $('viewport').hidden = false;
    $('downloadBtn').disabled = false;
    $('copyBtn').disabled = false;
    $('exportGifBtn').disabled = false;
    $('gifProgress').textContent = '';
    $('videoProgress').textContent = '';
    updateVisibility();
    refreshGifInfo();
    render();
  }

  function loadAsImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => { cleanupVideo(); state.gif = null; state.image = img; onImageReady(); };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function setupGif(gif) {
    cleanupVideo();
    state.gif = gif;
    const c = document.createElement('canvas');
    c.width = gif.width; c.height = gif.height;
    c.getContext('2d').putImageData(new ImageData(gif.frames[0].data, gif.width, gif.height), 0, 0);
    state.image = c;
    onImageReady();
  }

  /* ---------- video ------------------------------------------------------ */
  let videoRaf = 0;
  let scrubbing = false;

  function cleanupVideo() {
    if (state.camera) stopCamera(false);
    if (state.video) { try { state.video.pause(); } catch (e) {} }
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.video = null; state.videoUrl = null;
    cancelAnimationFrame(videoRaf);
  }

  function loadVideoFile(file) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.loop = true; v.preload = 'auto';
    v.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      $('gifInfo').textContent = 'Could not decode that video in this browser.';
    });
    v.addEventListener('loadeddata', async () => {
      // MediaRecorder-made WebMs report Infinity until forced to the end once
      if (!isFinite(v.duration)) {
        v.currentTime = 1e7;
        await once(v, 'durationchange', 3000);
        v.currentTime = 0;
        await once(v, 'seeked', 3000);
      }
      cleanupVideo();
      state.gif = null;
      state.video = v;
      state.videoUrl = url;
      state.image = v;
      wireVideo(v);
      onImageReady();
      v.play().catch(() => {});
    }, { once: true });
    v.src = url;
  }

  function wireVideo(v) {
    v.addEventListener('play', () => { $('videoPlayBtn').textContent = 'Pause'; startVideoLoop(); });
    v.addEventListener('pause', () => { $('videoPlayBtn').textContent = 'Play'; updateSeekUI(); });
    v.addEventListener('ended', () => { $('videoPlayBtn').textContent = 'Play'; });
    v.addEventListener('seeked', () => { if (!state.exporting) schedule(); });
  }

  function startVideoLoop() {
    cancelAnimationFrame(videoRaf);
    const step = () => {
      const v = state.video;
      if (!v || v.paused || v.ended || state.exporting) return;
      render();
      updateSeekUI();
      videoRaf = requestAnimationFrame(step);
    };
    videoRaf = requestAnimationFrame(step);
  }

  function updateSeekUI() {
    const v = state.video;
    if (!v) return;
    if (!scrubbing && isFinite(v.duration) && v.duration > 0) {
      $('videoSeek').value = Math.round((v.currentTime / v.duration) * 1000);
    }
    $('videoTime').textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration);
  }

  // seek and report whether the media actually landed near t — false means
  // the file's metadata claims more duration than it can seek to (bail out)
  async function seekVideo(v, t) {
    if (Math.abs(v.currentTime - t) <= 1e-4) return true;
    v.currentTime = t;
    await once(v, 'seeked', 3000);
    return Math.abs(v.currentTime - t) <= 0.5;
  }

  /* ---------- live camera ------------------------------------------------ */
  let camRaf = 0;
  let camRecorder = null;
  let camRecTimer = 0;

  function camMsg(text) { $('camMsg').textContent = text; }

  function startCameraLoop() {
    cancelAnimationFrame(camRaf);
    const step = () => {
      if (!state.camera || state.exporting) return;
      render();
      camRaf = requestAnimationFrame(step);
    };
    camRaf = requestAnimationFrame(step);
  }

  async function refreshCamDevices(currentId) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter((d) => d.kind === 'videoinput');
      const sel = $('camDevice');
      sel.innerHTML = '';
      cams.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || 'Camera ' + (i + 1);
        sel.appendChild(o);
      });
      if (currentId) sel.value = currentId;
      $('camDeviceWrap').hidden = cams.length < 2;
    } catch (err) { $('camDeviceWrap').hidden = true; }
  }

  async function startCamera(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMsg('Camera API unavailable — needs a secure context (https or localhost).');
      return;
    }
    $('camStartBtn').disabled = true;
    camMsg('Requesting camera…');
    try {
      const constraints = {
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cleanupVideo();                       // drops any loaded video AND a running camera
      state.gif = null;
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.srcObject = stream;
      await el.play();
      if (!el.videoWidth) await once(el, 'loadedmetadata', 3000);
      state.camera = { el, stream, mirror: $('camMirror').checked };
      state.image = el;
      onImageReady();
      startCameraLoop();
      camMsg(`Live — ${el.videoWidth}×${el.videoHeight}. Nothing leaves this device.`);
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => stopCamera(true)); // unplugged / OS revoked
        refreshCamDevices(track.getSettings && track.getSettings().deviceId);
      }
    } catch (err) {
      camMsg(err && err.name === 'NotAllowedError'
        ? 'Camera permission denied — allow it in the browser and try again.'
        : 'Camera failed: ' + (err && err.message || err));
    } finally {
      $('camStartBtn').disabled = false;
    }
  }

  // stop the stream; freeze=true keeps the last frame as the working image
  function stopCamera(freeze) {
    const cam = state.camera;
    if (!cam) return;
    if (camRecorder) { try { camRecorder.stop(); } catch (err) {} }
    cancelAnimationFrame(camRaf);
    let still = null;
    if (freeze && cam.el.videoWidth) {
      still = document.createElement('canvas');
      still.width = cam.el.videoWidth;
      still.height = cam.el.videoHeight;
      const c2 = still.getContext('2d');
      if (cam.mirror) { c2.translate(still.width, 0); c2.scale(-1, 1); } // bake the mirror in
      c2.drawImage(cam.el, 0, 0);
    }
    cam.stream.getTracks().forEach((t) => t.stop());
    state.camera = null;
    if (still) {
      state.image = still;
      camMsg('Camera stopped — last frame kept as the working image.');
      render();
    } else if (state.image === cam.el) {
      state.image = null;
      $('viewport').hidden = true;
      $('empty').hidden = false;
    }
    updateVisibility();
    refreshGifInfo();
  }

  function toggleCamRecord() {
    if (camRecorder) { try { camRecorder.stop(); } catch (err) {} return; }
    if (!window.MediaRecorder) { camMsg('Recording needs MediaRecorder — not supported here.'); return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { camMsg('No supported recording format.'); return; }
    const stream = canvas.captureStream(30);
    camRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks = [];
    camRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const t0 = Date.now();
    const btn = $('camRecBtn');
    camRecTimer = setInterval(() => {
      btn.textContent = '■ Stop ' + fmtTime((Date.now() - t0) / 1000);
    }, 500);
    camRecorder.onstop = () => {
      clearInterval(camRecTimer);
      camRecorder = null;
      btn.textContent = '● Record';
      btn.classList.remove('rec');
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      downloadBlob(blob, `ditherer-cam-${Date.now()}.${ext}`);
      camMsg(`Recorded ${fmtSize(blob.size)} ${ext.toUpperCase()}.`);
    };
    camRecorder.start(250);
    btn.textContent = '■ Stop 0:00';
    btn.classList.add('rec');
    camMsg('Recording the live preview…');
  }

  /* ---------- video export ----------------------------------------------- */
  function exportVideo() {
    return $('videoFormat').value === 'mp4' ? exportMp4() : exportWebm();
  }

  /* MP4: frame-accurate H.264 encode via WebCodecs + own ISO-BMFF muxer */
  async function exportMp4() {
    const v = state.video;
    if (!v || state.exporting) return;
    const btn = $('exportVideoBtn'), prog = $('videoProgress');
    if (!('VideoEncoder' in window)) {
      prog.textContent = 'MP4 needs WebCodecs (Chrome, Edge, Safari 16.4+, Firefox 130+). Use WebM instead.';
      return;
    }
    const s = readSettings();
    const sw = v.videoWidth, sh = v.videoHeight;
    const dims = outputDims(s);
    let W2, H2;
    if (dims) {                                   // fixed output size (even for H.264)
      W2 = Math.max(2, dims.W - (dims.W & 1)); H2 = Math.max(2, dims.H - (dims.H & 1));
    } else {
      const cp0 = cropParams(sw, sh);
      const [ww, wh] = workingDims(cp0 ? cp0.cw : sw, cp0 ? cp0.ch : sh, s);
      W2 = Math.max(2, ww & ~1); H2 = Math.max(2, wh & ~1);
    }
    const fps = +$('mp4Fps').value;
    const px = W2 * H2;
    // constrained-baseline ladder, level picked by frame size
    const ladder = px <= 414720 ? ['avc1.42E01E', 'avc1.42E01F', 'avc1.42E028']
      : px <= 921600 ? ['avc1.42E01F', 'avc1.42E028', 'avc1.42E032']
      : px <= 2097152 ? ['avc1.42E028', 'avc1.42E032']
      : ['avc1.42E032', 'avc1.42E033'];
    // dithered frames are noise-like — give the codec generous bitrate
    const bitrate = Math.min(16e6, Math.max(2e6, Math.round(px * fps * 0.3)));
    let config = null;
    for (const codec of ladder) {
      const c = { codec, width: W2, height: H2, bitrate, framerate: fps, avc: { format: 'avc' } };
      try {
        const r = await VideoEncoder.isConfigSupported(c);
        if (r.supported) { config = c; break; }
      } catch (err) { /* try next level */ }
    }
    if (!config) { prog.textContent = 'No supported H.264 encoder here — use WebM instead.'; return; }

    btn.disabled = true;
    $('exportGifBtn').disabled = true;
    const resume = !v.paused;
    v.pause();
    state.exporting = true;

    const samples = [];
    let avcC = null, encError = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!avcC && meta && meta.decoderConfig && meta.decoderConfig.description) {
          avcC = new Uint8Array(meta.decoderConfig.description);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, isKey: chunk.type === 'key' });
      },
      error: (e) => { encError = e; },
    });
    const tmp = document.createElement('canvas');
    tmp.width = W2; tmp.height = H2;
    const tctx = tmp.getContext('2d');

    try {
      enc.configure(config);
      const total = Math.max(1, Math.floor(v.duration * fps));
      for (let i = 0; i < total; i++) {
        if (encError) throw encError;
        const t = i / fps;
        if (t >= v.duration) break;
        if (!(await seekVideo(v, t))) break;
        const r = ditherSource(v, sw, sh, s);
        if (dims) composeFramed(canvasFromImageData(r.out), r.w, r.h, s, { target: tmp, even: true });
        else tctx.putImageData(r.out, 0, 0);         // native: clips odd row/col if any
        const frame = new VideoFrame(tmp, {
          timestamp: Math.round((i * 1e6) / fps),
          duration: Math.round(1e6 / fps),
        });
        enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (enc.encodeQueueSize > 4) await tick();
        prog.textContent = `Encoding frame ${i + 1}/${total}…`;
        if (i % 5 === 0) await tick();
      }
      prog.textContent = 'Finalizing…';
      await enc.flush();
      if (encError) throw encError;
      if (!avcC || !samples.length) throw new Error('encoder produced no output');
      const blob = Codec.muxMP4({ width: W2, height: H2, fps, samples, avcC });
      downloadBlob(blob, `dither-${Date.now()}.mp4`);
      prog.textContent = `Done — ${fmtSize(blob.size)} MP4 · ${samples.length} frames (silent)`;
    } catch (err) {
      console.error(err);
      prog.textContent = 'MP4 export failed: ' + err.message;
    } finally {
      try { enc.close(); } catch (err) { /* already closed */ }
      state.exporting = false;
      if (resume) v.play().catch(() => {});
      btn.disabled = false;
      $('exportGifBtn').disabled = false;
    }
  }

  /* WebM: real-time MediaRecorder capture of the live preview (with audio) */
  async function exportWebm() {
    const v = state.video;
    if (!v || state.exporting) return;
    const btn = $('exportVideoBtn'), prog = $('videoProgress');
    if (!window.MediaRecorder) { prog.textContent = 'MediaRecorder is not supported in this browser.'; return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { prog.textContent = 'No supported recording format found.'; return; }

    btn.disabled = true;
    $('exportGifBtn').disabled = true;

    const stream = canvas.captureStream(30);
    const restoreMuted = v.muted;
    try {
      // include the original audio track where the browser supports tapping it
      const cap = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null);
      if (cap) {
        v.muted = false;
        cap.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
    } catch (err) { /* video-only recording */ }

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });

    const wasLoop = v.loop;
    v.loop = false;
    v.pause();
    if (v.currentTime > 1e-4) { v.currentTime = 0; await once(v, 'seeked', 3000); }
    render();

    const onProgress = () => { prog.textContent = `Recording… ${v.currentTime.toFixed(1)} / ${v.duration.toFixed(1)} s`; };
    v.addEventListener('timeupdate', onProgress);
    rec.start(250);
    try { await v.play(); }
    catch (err) { v.muted = true; await v.play().catch(() => {}); }
    await Promise.race([once(v, 'ended'), once(v, 'pause')]); // pausing stops the recording early
    rec.stop();
    await stopped;

    v.removeEventListener('timeupdate', onProgress);
    v.loop = wasLoop;
    v.muted = restoreMuted;

    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    downloadBlob(blob, `dither-${Date.now()}.${ext}`);
    prog.textContent = `Done — ${fmtSize(blob.size)} ${ext.toUpperCase()}`;
    btn.disabled = false;
    $('exportGifBtn').disabled = false;
  }

  /* ---------- single-image export (PNG) --------------------------------- */
  function buildExportCanvas() {
    // the visible canvas already holds the composed frame; fixed output is
    // exact (scale 1), native output upscales by the chosen export scale.
    const s = readSettings();
    const scale = outputDims(s) ? 1 : s.exportScale;
    const ex = document.createElement('canvas');
    ex.width = canvas.width * scale; ex.height = canvas.height * scale;
    const ectx = ex.getContext('2d');
    ectx.imageSmoothingEnabled = false;
    ectx.drawImage(canvas, 0, 0, ex.width, ex.height);
    return ex;
  }
  function download() {
    if (!state.lastOutput) return;
    buildExportCanvas().toBlob((blob) => downloadBlob(blob, `dither-${Date.now()}.png`), 'image/png');
  }
  async function copyToClipboard() {
    if (!state.lastOutput) return;
    try {
      const blob = await new Promise((r) => buildExportCanvas().toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash($('copyBtn'), 'Copied!');
    } catch (err) { flash($('copyBtn'), 'Blocked'); }
  }

  /* ---------- animated GIF export --------------------------------------- */
  async function exportGif() {
    if (!state.image || state.exporting) return;
    const s = readSettings();
    const btn = $('exportGifBtn'), prog = $('gifProgress');
    btn.disabled = true;
    await tick();

    const frames = [];
    let W, H;
    let resumeVideo = false;
    const dims = outputDims(s);
    const memGuard = (n) => {
      if (dims && dims.W * dims.H * 4 * n > 600e6) {
        throw new Error(`output too large for GIF (${dims.W}×${dims.H} × ${n} frames). ` +
          'Pick a smaller output size or fewer frames.');
      }
    };
    // compose each dithered frame into the chosen output size (or native)
    const pushFrame = (out, w, h, delayCs) => {
      if (dims) {
        const c = composeFramed(canvasFromImageData(out), w, h, s, {});
        W = c.width; H = c.height;
        frames.push({ data: c.getContext('2d').getImageData(0, 0, W, H).data, delayCs });
      } else {
        W = w; H = h;
        frames.push({ data: out.data, delayCs });
      }
    };
    try {
      if (state.gif) {
        const g = state.gif;
        memGuard(g.frames.length);
        for (let i = 0; i < g.frames.length; i++) {
          gifTmp.width = g.width; gifTmp.height = g.height;
          gtctx.putImageData(new ImageData(g.frames[i].data, g.width, g.height), 0, 0);
          const r = ditherSource(gifTmp, g.width, g.height, s);
          pushFrame(r.out, r.w, r.h, Math.max(2, g.frames[i].delayCs || 10));
          prog.textContent = `Dithering frame ${i + 1}/${g.frames.length}…`;
          if (i % 3 === 0) await tick();
        }
      } else if (state.video) {
        // sample the video timeline frame by frame
        const v = state.video;
        resumeVideo = !v.paused;
        v.pause();
        state.exporting = true;
        const fps = +$('animFps').value;
        const total = Math.max(1, Math.min(Math.floor(v.duration * fps), MAX_GIF_FRAMES));
        const delay = Math.max(2, Math.round(100 / fps));
        memGuard(total);
        for (let i = 0; i < total; i++) {
          const t = i / fps;
          if (t >= v.duration) break;
          if (!(await seekVideo(v, t))) break;
          const r = ditherSource(v, v.videoWidth, v.videoHeight, s);
          pushFrame(r.out, r.w, r.h, delay);
          prog.textContent = `Dithering frame ${i + 1}/${total}…`;
          if (i % 3 === 0) await tick();
        }
      } else {
        const [sw, sh] = srcDims();
        const N = +$('animFrames').value;
        const delay = Math.max(2, Math.round(100 / +$('animFps').value));
        memGuard(N);
        for (let i = 0; i < N; i++) {
          const r = ditherSource(state.image, sw, sh, s, { jitter: 20, phase: i });
          pushFrame(r.out, r.w, r.h, delay);
          prog.textContent = `Rendering frame ${i + 1}/${N}…`;
          if (i % 3 === 0) await tick();
        }
      }
      prog.textContent = 'Encoding GIF…';
      await tick();
      const blob = Codec.encodeGIF(W, H, frames, { loop: 0 });
      downloadBlob(blob, `dither-${Date.now()}.gif`);
      prog.textContent = `Done — ${frames.length} frames · ${(blob.size / 1024).toFixed(0)} KB`;
    } catch (err) {
      console.error(err);
      prog.textContent = 'GIF export failed: ' + err.message;
    } finally {
      state.exporting = false;
      if (resumeVideo && state.video) state.video.play().catch(() => {});
      btn.disabled = false;
    }
  }

  /* ---------- batch processing → ZIP ------------------------------------ */
  function addBatchFiles(files) {
    for (const f of files) if (f.type.startsWith('image/')) state.batch.push(f);
    renderBatchList();
  }
  function renderBatchList() {
    const ul = $('batchList');
    ul.innerHTML = '';
    state.batch.forEach((f, i) => {
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(f.name));
      const x = document.createElement('button');
      x.className = 'rm'; x.textContent = '×'; x.title = 'Remove';
      x.addEventListener('click', () => { state.batch.splice(i, 1); renderBatchList(); });
      li.appendChild(x);
      ul.appendChild(li);
    });
    $('batchRunBtn').disabled = state.batch.length === 0;
    $('batchProgress').textContent = state.batch.length ? `${state.batch.length} image(s) queued.` : '';
  }
  async function runBatch() {
    if (!state.batch.length) return;
    const s = readSettings();
    const btn = $('batchRunBtn'), prog = $('batchProgress');
    btn.disabled = true;
    const files = [];
    for (let i = 0; i < state.batch.length; i++) {
      const f = state.batch[i];
      prog.textContent = `Processing ${i + 1}/${state.batch.length}: ${f.name}`;
      await tick();
      try {
        const img = await loadFileToImage(f);
        const { out, w, h } = ditherSource(img, img.naturalWidth, img.naturalHeight, s);
        const framed = composeFramed(canvasFromImageData(out), w, h, s,
          { scale: outputDims(s) ? 1 : s.exportScale });
        const blob = await new Promise((r) => framed.toBlob(r, 'image/png'));
        const buf = new Uint8Array(await blob.arrayBuffer());
        files.push({ name: baseName(f.name) + '-dither.png', data: buf });
      } catch (err) { console.warn('skipped', f.name, err); }
    }
    prog.textContent = 'Zipping…';
    await tick();
    const zip = Codec.zipStore(files);
    downloadBlob(zip, `dither-batch-${Date.now()}.zip`);
    prog.textContent = `Done — ${files.length} image(s) zipped · ${(zip.size / 1024).toFixed(0)} KB`;
    btn.disabled = false;
  }

  /* ---------- small helpers --------------------------------------------- */
  function downloadBlob(blob, name) {
    window.__lastExport = { blob, name, at: Date.now() }; // debug/testing hook
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function loadFileToImage(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = (e) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = e.target.result; };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  function canvasFromImageData(id) {
    const c = document.createElement('canvas');
    c.width = id.width; c.height = id.height;
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }
  function upscaleImageDataToBlob(id, scale) {
    const src = canvasFromImageData(id);
    const c = document.createElement('canvas');
    c.width = id.width * scale; c.height = id.height * scale;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(src, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  function flash(btn, txt) { const old = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = old; }, 1100); }

  /* ---------- custom palette editor ------------------------------------- */
  function renderCustomPalette() {
    const grid = $('customPalette');
    grid.innerHTML = '';
    state.customColors.forEach((hex, i) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.background = hex;
      chip.title = hex + ' — click to remove';
      chip.addEventListener('click', () => {
        if (state.customColors.length <= 2) return;
        state.customColors.splice(i, 1); renderCustomPalette(); schedule();
      });
      grid.appendChild(chip);
    });
  }

  /* ---------- visibility logic ------------------------------------------ */
  function updateVisibility() {
    const s = readSettings();
    const algo = Dither.ALGORITHMS[s.algorithm];
    $('amountWrap').hidden = !(algo.type === 'error' || algo.type === 'ordered' || algo.type === 'random');
    $('halftoneWrap').hidden = algo.type !== 'halftone';
    $('serpentineWrap').hidden = algo.type !== 'error';
    $('levelsWrap').hidden = s.mode !== 'grayscale';
    $('duoWrap').hidden = s.mode === 'color';
    $('colorWrap').hidden = s.mode !== 'color';
    $('customWrap').hidden = !(s.mode === 'color' && s.palette === 'custom');
    $('shimmerFramesWrap').hidden = !!state.gif || !!state.video;
    $('videoPanel').hidden = !state.video;
    const camOn = !!state.camera;
    $('camStopBtn').hidden = !camOn;
    $('camActionsWrap').hidden = !camOn;
    $('camMirrorWrap').hidden = !camOn;
    if (!camOn) $('camDeviceWrap').hidden = true;
    $('camStartBtn').textContent = camOn ? 'Restart camera' : 'Start camera';
    const fixed = !!outputDims(s);
    $('customSizeWrap').hidden = s.outputSize !== 'custom';
    $('scaleWrap').hidden = fixed;             // export scale only applies to native output
    $('fitWrap').hidden = !fixed;
    $('fillWrap').hidden = !(fixed && s.fitMode === 'contain');
    $('mp4FpsWrap').hidden = $('videoFormat').value !== 'mp4';
    $('videoHint').textContent = $('videoFormat').value === 'mp4'
      ? 'Frame-accurate H.264 encode via WebCodecs — plays everywhere, but silent (no audio). ' +
        'Use WebM to keep the soundtrack.'
      : 'Records the live preview in real time (takes as long as the clip), original audio included ' +
        'where the browser supports it. Slider changes during recording are captured too.';

    const labels = $('duoWrap').querySelectorAll('.swatch span');
    if (s.mode === 'grayscale') { labels[0].textContent = 'Dark tint'; labels[1].textContent = 'Light tint'; }
    else { labels[0].textContent = 'Ink'; labels[1].textContent = 'Paper'; }
  }

  function refreshGifInfo() {
    const info = $('gifInfo');
    if (state.camera) {
      info.textContent = `Live camera — “Export animated GIF” grabs ${$('animFrames').value} consecutive live frames.`;
    } else if (state.video) {
      info.textContent = `Video — “Export animated GIF” samples it at ${$('animFps').value} fps ` +
        `(up to ${MAX_GIF_FRAMES} frames). For full quality use the WebM export below.`;
    } else if (state.gif) {
      info.textContent = `Animated GIF — ${state.gif.frames.length} frames ` +
        `(${state.gif.width}×${state.gif.height}). Export re-dithers every frame.`;
    } else if (state.image) {
      info.textContent = `Still image — “Export animated GIF” will animate it (${$('animFrames').value} frames).`;
    } else {
      info.textContent = 'No image loaded.';
    }
  }

  /* ---------- populate selects ------------------------------------------ */
  function buildAlgorithmSelect() {
    const sel = $('algorithm');
    const groups = {};
    for (const [key, a] of Object.entries(Dither.ALGORITHMS)) (groups[a.group] = groups[a.group] || []).push([key, a.label]);
    for (const [group, items] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = group;
      for (const [key, label] of items) {
        const o = document.createElement('option');
        o.value = key; o.textContent = label; og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = DEFAULTS.algorithm;
  }
  function buildPaletteSelect() {
    const sel = $('palette');
    for (const [key, p] of Object.entries(PALETTES)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = p.name; sel.appendChild(o);
    }
    const o = document.createElement('option');
    o.value = 'custom'; o.textContent = '★ Custom palette'; sel.appendChild(o);
    sel.value = DEFAULTS.palette;
  }

  function syncOutputs() {
    ALL_DIALS.forEach((id) => {
      const el = $(id), out = $(id + 'Out');
      // don't fight the user while they're typing in the number box
      if (el && out && document.activeElement !== out) out.value = el.value;
    });
  }

  /* ---------- reset / randomize ----------------------------------------- */
  function applyDefaults() {
    $('resolution').value = DEFAULTS.resolution;
    ['brightness', 'contrast', 'midtones', 'saturation', 'hue', 'glow', 'signal', 'scanlines', 'noise', 'chroma'].forEach((id) => { $(id).value = 0; });
    $('invert').checked = false;
    $('algorithm').value = DEFAULTS.algorithm; $('amount').value = 100;
    $('halftoneSize').value = 6; $('serpentine').checked = true;
    $('mode').value = DEFAULTS.mode; $('levels').value = 2; $('palette').value = DEFAULTS.palette;
    $('inkColor').value = DEFAULTS.ink; $('paperColor').value = DEFAULTS.paper;
    $('animFrames').value = DEFAULTS.animFrames; $('animFps').value = DEFAULTS.animFps;
    $('outputSize').value = 'native'; $('fitMode').value = 'contain';
    $('outW').value = 1920; $('outH').value = 1080;
    setFill('#000000');
    resetTransform();
    syncOutputs(); updateVisibility(); refreshGifInfo();
  }
  function randomize() {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
    $('algorithm').value = pick(Object.keys(Dither.ALGORITHMS));
    $('contrast').value = rnd(-20, 40);
    $('midtones').value = rnd(-30, 30);
    $('amount').value = rnd(70, 130);
    $('mode').value = pick(['bw', 'grayscale', 'color', 'color']);
    $('levels').value = rnd(2, 6);
    $('palette').value = pick(Object.keys(PALETTES));
    syncOutputs(); updateVisibility(); schedule();
  }

  /* ---------- settings presets ------------------------------------------ */
  const PRESET_LS_KEY = 'ditherer-presets';

  function loadStoredPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_LS_KEY)) || {}; }
    catch (err) { return {}; }
  }
  function storePresets(map) {
    try { localStorage.setItem(PRESET_LS_KEY, JSON.stringify(map)); }
    catch (err) { presetMsg('Could not persist presets (storage unavailable).'); }
  }
  function presetMsg(text) { $('presetMsg').textContent = text; }

  // full snapshot of every control, the custom palette and the crop transform
  function capturePreset(name) {
    return {
      app: 'ditherer-preset',
      version: 1,
      name,
      saved: new Date().toISOString(),
      settings: readSettings(),
      animFrames: +$('animFrames').value,
      animFps: +$('animFps').value,
      customColors: state.customColors.slice(),
      transform: Object.assign({}, state.transform),
      videoFormat: $('videoFormat').value,
      mp4Fps: $('mp4Fps').value,
    };
  }

  // apply with validation — unknown keys are ignored, bad values fall back,
  // range inputs clamp out-of-range numbers to their min/max on their own
  function applyPreset(p) {
    if (!p || typeof p !== 'object' || typeof p.settings !== 'object' || p.settings === null) {
      throw new Error('not a Ditherer preset file');
    }
    const s = p.settings;
    const hexOk = (h) => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h);
    ['resolution', 'brightness', 'contrast', 'midtones', 'saturation', 'hue',
     'amount', 'halftoneSize', 'levels', 'glow', 'signal', 'scanlines', 'noise', 'chroma'].forEach((id) => {
      if (s[id] != null && isFinite(+s[id])) $(id).value = +s[id];
    });
    if (p.animFrames != null && isFinite(+p.animFrames)) $('animFrames').value = +p.animFrames;
    if (p.animFps != null && isFinite(+p.animFps)) $('animFps').value = +p.animFps;
    $('invert').checked = !!s.invert;
    $('serpentine').checked = s.serpentine !== false;
    if (Dither.ALGORITHMS[s.algorithm]) $('algorithm').value = s.algorithm;
    if (['bw', 'grayscale', 'color'].indexOf(s.mode) >= 0) $('mode').value = s.mode;
    if (s.palette === 'custom' || PALETTES[s.palette]) $('palette').value = s.palette;
    if (hexOk(s.ink)) $('inkColor').value = s.ink;
    if (hexOk(s.paper)) $('paperColor').value = s.paper;
    if ([1, 2, 4, 8].indexOf(+s.exportScale) >= 0) $('exportScale').value = String(+s.exportScale);
    if (s.outputSize && Array.prototype.some.call($('outputSize').options, (o) => o.value === s.outputSize)) {
      $('outputSize').value = s.outputSize;
    }
    if (isFinite(+s.outW) && +s.outW >= 1) $('outW').value = Math.min(8192, Math.round(+s.outW));
    if (isFinite(+s.outH) && +s.outH >= 1) $('outH').value = Math.min(8192, Math.round(+s.outH));
    if (['contain', 'cover', 'stretch'].indexOf(s.fitMode) >= 0) $('fitMode').value = s.fitMode;
    if (hexOk(s.fillColor)) setFill(s.fillColor);
    if (Array.isArray(p.customColors)) {
      const cc = p.customColors.filter(hexOk);
      if (cc.length >= 2) state.customColors = cc;
    }
    if (p.transform && typeof p.transform === 'object') {
      const t = p.transform;
      const ratioOk = Array.prototype.some.call($('cropRatio').options, (o) => o.value === t.ratio);
      state.transform = {
        angle: Math.max(-45, Math.min(45, isFinite(+t.angle) ? +t.angle : 0)),
        rot: ((Math.round(+t.rot || 0) % 4) + 4) % 4,
        ratio: ratioOk ? t.ratio : 'free',
        zoom: Math.max(1, Math.min(4, isFinite(+t.zoom) ? +t.zoom : 1)),
        ox: Math.max(0, Math.min(1, isFinite(+t.ox) ? +t.ox : 0.5)),
        oy: Math.max(0, Math.min(1, isFinite(+t.oy) ? +t.oy : 0.5)),
      };
      $('cropRatio').value = state.transform.ratio;
      $('straighten').value = state.transform.angle;
      $('cropZoom').value = state.transform.zoom;
      canvas.style.cursor = state.transform.zoom > 1.001 ? 'grab' : '';
    }
    if (p.videoFormat === 'webm' || (p.videoFormat === 'mp4' && 'VideoEncoder' in window)) {
      $('videoFormat').value = p.videoFormat;
    }
    if (p.mp4Fps && Array.prototype.some.call($('mp4Fps').options, (o) => o.value === String(p.mp4Fps))) {
      $('mp4Fps').value = String(p.mp4Fps);
    }
    renderCustomPalette();
    syncOutputs(); updateVisibility(); refreshGifInfo(); schedule();
  }

  function refreshPresetSelect(selectName) {
    const sel = $('presetSelect');
    const names = Object.keys(loadStoredPresets()).sort((a, b) => a.localeCompare(b));
    sel.innerHTML = '<option value="">— saved presets —</option>';
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = selectName || '';
  }

  function importPresetFile(file) {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const p = JSON.parse(e.target.result);
        const name = (typeof p.name === 'string' && p.name.trim()) ||
          file.name.replace(/\.ditherer\.json$|\.json$/i, '') || 'Imported preset';
        p.name = name;
        applyPreset(p);
        const map = loadStoredPresets();
        map[name] = p;
        storePresets(map);
        refreshPresetSelect(name);
        $('presetName').value = name;
        presetMsg(`Imported & applied “${name}”.`);
      } catch (err) {
        presetMsg('Import failed: ' + err.message);
      }
    };
    r.readAsText(file);
  }

  /* ---------- wiring ----------------------------------------------------- */
  function init() {
    if (!('VideoEncoder' in window)) {
      const opt = $('videoFormat').querySelector('option[value="mp4"]');
      opt.disabled = true;
      opt.textContent += ' — unsupported in this browser';
      $('videoFormat').value = 'webm';
    }
    buildAlgorithmSelect();
    buildPaletteSelect();
    renderCustomPalette();
    syncOutputs();
    updateVisibility();
    refreshGifInfo();

    // generic: any control change re-renders (rAF-debounced)
    document.querySelectorAll('input, select').forEach((el) => {
      const evt = el.type === 'range' ? 'input' : 'change';
      el.addEventListener(evt, () => { syncOutputs(); updateVisibility(); refreshGifInfo(); schedule(); });
    });

    // number boxes ↔ sliders: type a value to set any dial precisely
    ALL_DIALS.forEach((id) => {
      const slider = $(id), num = $(id + 'Out');
      if (!slider || !num) return;
      num.min = slider.min; num.max = slider.max; num.step = slider.step || 'any';
      num.value = slider.value;
      num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!isFinite(v)) return;
        slider.value = v;                  // browser clamps to the slider's range
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
      num.addEventListener('change', () => { num.value = slider.value; }); // snap on blur
    });

    // upload via drop zone
    const drop = $('dropZone');
    drop.addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => loadImageFile(e.target.files[0]));
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => loadImageFile(e.dataTransfer.files[0]));

    // drop anywhere on the stage
    const stage = document.querySelector('.stage');
    ['dragenter', 'dragover'].forEach((t) => stage.addEventListener(t, (e) => e.preventDefault()));
    stage.addEventListener('drop', (e) => { e.preventDefault(); loadImageFile(e.dataTransfer.files[0]); });

    // paste from clipboard
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) if (it.type.startsWith('image/')) { loadImageFile(it.getAsFile()); break; }
    });

    // crop & straighten
    let gridTimer = 0;
    const showGrid = () => {
      $('gridOverlay').hidden = false;
      clearTimeout(gridTimer);
      gridTimer = setTimeout(() => { $('gridOverlay').hidden = true; }, 900);
    };
    $('cropRatio').addEventListener('change', () => {
      state.transform.ratio = $('cropRatio').value;
      showGrid();
    });
    $('straighten').addEventListener('input', () => {
      state.transform.angle = +$('straighten').value;
      showGrid();
    });
    $('cropZoom').addEventListener('input', () => {
      state.transform.zoom = +$('cropZoom').value;
      canvas.style.cursor = state.transform.zoom > 1.001 ? 'grab' : '';
      showGrid();
    });
    $('rotL').addEventListener('click', () => { state.transform.rot = (state.transform.rot + 3) % 4; schedule(); });
    $('rotR').addEventListener('click', () => { state.transform.rot = (state.transform.rot + 1) % 4; schedule(); });
    $('cropResetBtn').addEventListener('click', () => { resetTransform(); schedule(); });

    // drag the preview to reframe when zoomed past 1x
    let panDrag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (eyedropping) { e.preventDefault(); pickColorAt(e); return; }
      if (!state.image || state.transform.zoom <= 1.001) return;
      panDrag = { x: e.clientX, y: e.clientY, ox: state.transform.ox, oy: state.transform.oy };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panDrag) return;
      const t = state.transform;
      const [sw, sh] = srcDims();
      const cp = cropParams(sw, sh);
      if (!cp) return;
      const pxPerUnit = canvas.clientWidth / cp.cw;   // display px per source unit
      const slackX = cp.cw * (t.zoom - 1), slackY = cp.ch * (t.zoom - 1);
      if (slackX > 1e-6) t.ox = Math.min(1, Math.max(0, panDrag.ox - (e.clientX - panDrag.x) / pxPerUnit / slackX));
      if (slackY > 1e-6) t.oy = Math.min(1, Math.max(0, panDrag.oy - (e.clientY - panDrag.y) / pxPerUnit / slackY));
      showGrid();
      schedule();
    });
    const endPan = () => {
      if (!panDrag) return;
      panDrag = null;
      canvas.style.cursor = state.transform.zoom > 1.001 ? 'grab' : '';
    };
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);

    // custom palette
    $('addColor').addEventListener('click', () => {
      state.customColors.push($('newColor').value);
      $('palette').value = 'custom';
      renderCustomPalette(); updateVisibility(); schedule();
    });
    $('extractBtn').addEventListener('click', () => {
      if (!state.image) return;
      const s = readSettings();
      const [sw, sh] = srcDims();
      const [w, h] = workingDims(sw, sh, s);
      work.width = w; work.height = h;
      wctx.clearRect(0, 0, w, h);
      wctx.drawImage(state.image, 0, 0, w, h);
      const pal = Dither.extractPalette(wctx.getImageData(0, 0, w, h), +$('extractCount').value);
      state.customColors = pal.map(rgbToHex);
      $('mode').value = 'color'; $('palette').value = 'custom';
      renderCustomPalette(); updateVisibility(); schedule();
    });

    // exports
    $('downloadBtn').addEventListener('click', download);
    $('copyBtn').addEventListener('click', copyToClipboard);
    $('exportGifBtn').addEventListener('click', exportGif);
    $('exportVideoBtn').addEventListener('click', exportVideo);

    // output fill colour: keep the picker and the hex box in sync
    $('fillColor').addEventListener('input', () => {
      $('fillHex').value = $('fillColor').value.toUpperCase();
      schedule();
    });
    $('fillHex').addEventListener('input', () => {
      let v = $('fillHex').value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { $('fillColor').value = v.toLowerCase(); schedule(); }
    });
    $('eyedropBtn').addEventListener('click', () => (eyedropping ? stopEyedrop() : startEyedrop()));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && eyedropping) stopEyedrop(); });

    // video transport
    $('videoPlayBtn').addEventListener('click', () => {
      const v = state.video;
      if (!v) return;
      if (v.paused || v.ended) v.play().catch(() => {}); else v.pause();
    });
    const seekEl = $('videoSeek');
    seekEl.addEventListener('pointerdown', () => { scrubbing = true; });
    window.addEventListener('pointerup', () => { scrubbing = false; });
    seekEl.addEventListener('input', () => {
      const v = state.video;
      if (!v || !isFinite(v.duration) || state.exporting) return;
      v.currentTime = (seekEl.value / 1000) * v.duration;
      updateSeekUI();
    });

    // batch
    $('batchAddBtn').addEventListener('click', () => $('batchInput').click());
    $('batchInput').addEventListener('change', (e) => { addBatchFiles(e.target.files); e.target.value = ''; });
    $('batchRunBtn').addEventListener('click', runBatch);

    // presets
    refreshPresetSelect();
    const savePreset = () => {
      let name = $('presetName').value.trim();
      if (!name) name = 'Preset ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
      const map = loadStoredPresets();
      const existed = !!map[name];
      map[name] = capturePreset(name);
      storePresets(map);
      refreshPresetSelect(name);
      presetMsg(existed ? `Updated “${name}”.` : `Saved “${name}”.`);
    };
    $('presetSaveBtn').addEventListener('click', savePreset);
    $('presetName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); savePreset(); }
    });
    $('presetSelect').addEventListener('change', () => {
      const name = $('presetSelect').value;
      if (!name) return;
      const p = loadStoredPresets()[name];
      if (!p) { presetMsg('Preset not found.'); return; }
      try {
        applyPreset(p);
        $('presetName').value = name;
        presetMsg(`Applied “${name}”.`);
      } catch (err) { presetMsg('Could not apply: ' + err.message); }
    });
    $('presetDownloadBtn').addEventListener('click', () => {
      const selected = $('presetSelect').value;
      const name = selected || $('presetName').value.trim() || 'settings';
      const p = (selected && loadStoredPresets()[selected]) || capturePreset(name);
      const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
      const fname = name.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
      downloadBlob(blob, fname + '.ditherer.json');
      presetMsg(selected ? `Downloaded “${name}”.` : 'Downloaded current settings.');
    });
    $('presetImportBtn').addEventListener('click', () => $('presetFileInput').click());
    $('presetFileInput').addEventListener('change', (e) => {
      if (e.target.files[0]) importPresetFile(e.target.files[0]);
      e.target.value = '';
    });
    $('presetDeleteBtn').addEventListener('click', () => {
      const name = $('presetSelect').value;
      if (!name) { presetMsg('Select a preset to delete.'); return; }
      const map = loadStoredPresets();
      delete map[name];
      storePresets(map);
      refreshPresetSelect();
      presetMsg(`Deleted “${name}”.`);
    });

    // camera
    $('camStartBtn').addEventListener('click', () => startCamera($('camDevice').value || undefined));
    $('camStopBtn').addEventListener('click', () => stopCamera(true));
    $('camMirror').addEventListener('change', () => {
      if (state.camera) state.camera.mirror = $('camMirror').checked;
    });
    $('camDevice').addEventListener('change', () => {
      if (state.camera) startCamera($('camDevice').value);
    });
    $('camSnapBtn').addEventListener('click', download);
    $('camRecBtn').addEventListener('click', toggleCamRecord);

    // misc
    $('resetBtn').addEventListener('click', () => { applyDefaults(); schedule(); });
    $('randomBtn').addEventListener('click', randomize);
    $('showOriginal').addEventListener('change', schedule);
    window.addEventListener('resize', () => { if (state.lastOutput) fitCanvas(canvas.width, canvas.height); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
