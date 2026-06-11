/* ============================================================================
   Dither Boy (local) — UI + pipeline orchestration
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

  const MAX_GIF_FRAMES = 200; // cap for video → GIF sampling

  /* ---------- preset palettes ------------------------------------------- */
  const PALETTES = {
    'bw': { name: 'Black & White', colors: [[0, 0, 0], [255, 255, 255]] },
    'gameboy': { name: 'Game Boy (DMG)', colors: [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]] },
    'gameboy-pocket': { name: 'Game Boy Pocket', colors: [[8, 24, 32], [52, 104, 86], [136, 192, 112], [224, 248, 208]] },
    'cga': { name: 'CGA (cyan/magenta)', colors: [[0, 0, 0], [85, 255, 255], [255, 85, 255], [255, 255, 255]] },
    'cga-yellow': { name: 'CGA (red/green/yellow)', colors: [[0, 0, 0], [85, 255, 85], [255, 85, 85], [255, 255, 85]] },
    'sepia': { name: 'Sepia', colors: [[44, 25, 16], [108, 67, 44], [173, 122, 79], [232, 197, 152], [255, 245, 222]] },
    'c64': {
      name: 'Commodore 64',
      colors: [[0, 0, 0], [255, 255, 255], [136, 57, 50], [103, 182, 189], [139, 63, 150], [85, 160, 73],
               [64, 49, 141], [191, 206, 114], [139, 84, 41], [87, 66, 0], [184, 105, 98], [80, 80, 80],
               [120, 120, 120], [148, 224, 137], [120, 105, 196], [159, 159, 159]],
    },
    'pico8': {
      name: 'PICO-8',
      colors: [[0, 0, 0], [29, 43, 83], [126, 37, 83], [0, 135, 81], [171, 82, 54], [95, 87, 79],
               [194, 195, 199], [255, 241, 232], [255, 0, 77], [255, 163, 0], [255, 236, 39], [0, 228, 54],
               [41, 173, 255], [131, 118, 156], [255, 119, 168], [255, 204, 170]],
    },
    'zx': { name: 'ZX Spectrum-ish', colors: [[0,0,0],[0,0,215],[215,0,0],[215,0,215],[0,215,0],[0,215,215],[215,215,0],[255,255,255]] },
    'cmyk': { name: 'CMYK', colors: [[0,0,0],[0,174,239],[236,0,140],[255,242,0],[255,255,255]] },
  };

  /* ---------- state ----------------------------------------------------- */
  const state = {
    image: null,          // current preview source: <img>, <canvas> (gif frame 0) or <video>
    gif: null,            // { width, height, frames:[{data,delayCs}] } when an animated GIF is loaded
    video: null,          // <video> element when a video is loaded
    videoUrl: null,       // object URL backing the video (revoked on replace)
    exporting: false,     // true during seek-based exports; pauses the live loop
    batch: [],            // queued File objects for batch processing
    customColors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179'],
    lastOutput: null,     // { w, h } of the last preview render
  };

  const DEFAULTS = {
    resolution: 500, algorithm: 'floyd-steinberg', mode: 'bw', palette: 'gameboy',
    ink: '#0b0b0d', paper: '#f2f2f2', animFrames: 12, animFps: 12,
  };
  const SLIDERS = ['resolution', 'brightness', 'contrast', 'midtones', 'saturation', 'hue',
                   'amount', 'halftoneSize', 'levels', 'extractCount', 'scanlines', 'noise', 'chroma',
                   'animFrames', 'animFps'];

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
      scanlines: +$('scanlines').value,
      noise: +$('noise').value,
      chroma: +$('chroma').value,
      exportScale: +$('exportScale').value,
    };
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

  /* ---------- the core: dither any drawable to an ImageData ------------- */
  // opts: { jitter:Number (animated grain), phase:Number (ordered-matrix offset) }
  function ditherSource(drawable, sw, sh, s, opts) {
    opts = opts || {};
    const [w, h] = workingDims(sw, sh, s);
    work.width = w; work.height = h;
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.clearRect(0, 0, w, h);
    wctx.fillStyle = '#ffffff';          // flatten transparency onto white
    wctx.fillRect(0, 0, w, h);
    wctx.drawImage(drawable, 0, 0, w, h);

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
      const [w, h] = workingDims(sw, sh, s);
      canvas.width = w; canvas.height = h;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(state.image, 0, 0, w, h);
      state.lastOutput = { w, h };
      fitCanvas(w, h); updateStatus(s, sw, sh, w, h);
      return;
    }

    const { out, w, h } = ditherSource(state.image, sw, sh, s);
    canvas.width = w; canvas.height = h;
    ctx.putImageData(out, 0, 0);
    state.lastOutput = { w, h };
    fitCanvas(w, h); updateStatus(s, sw, sh, w, h);
  }

  function updateStatus(s, sw, sh, w, h) {
    $('status').hidden = false;
    const extra = state.gif ? ` · <b>${state.gif.frames.length}</b> GIF frames`
      : state.video ? ` · <b>${fmtTime(state.video.duration)}</b> clip` : '';
    $('status').innerHTML = `<b>${sw}×${sh}</b> source · dithered at <b>${w}×${h}</b> · ` +
      `export <b>${w * s.exportScale}×${h * s.exportScale}</b>${extra}`;
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

  /* ---------- video export (WebM via MediaRecorder) ---------------------- */
  async function exportVideo() {
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
    prog.textContent = `Done — ${(blob.size / 1024 / 1024).toFixed(1)} MB ${ext.toUpperCase()}`;
    btn.disabled = false;
    $('exportGifBtn').disabled = false;
  }

  /* ---------- single-image export (PNG) --------------------------------- */
  function buildExportCanvas() {
    const s = readSettings();
    const { w, h } = state.lastOutput;
    const ex = document.createElement('canvas');
    ex.width = w * s.exportScale; ex.height = h * s.exportScale;
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
    try {
      if (state.gif) {
        const g = state.gif;
        for (let i = 0; i < g.frames.length; i++) {
          gifTmp.width = g.width; gifTmp.height = g.height;
          gtctx.putImageData(new ImageData(g.frames[i].data, g.width, g.height), 0, 0);
          const r = ditherSource(gifTmp, g.width, g.height, s);
          W = r.w; H = r.h;
          frames.push({ data: r.out.data, delayCs: Math.max(2, g.frames[i].delayCs || 10) });
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
        for (let i = 0; i < total; i++) {
          const t = i / fps;
          if (t >= v.duration) break;
          if (Math.abs(v.currentTime - t) > 1e-4) {
            v.currentTime = t;
            await once(v, 'seeked', 3000);
          }
          const r = ditherSource(v, v.videoWidth, v.videoHeight, s);
          W = r.w; H = r.h;
          frames.push({ data: r.out.data, delayCs: delay });
          prog.textContent = `Dithering frame ${i + 1}/${total}…`;
          if (i % 3 === 0) await tick();
        }
      } else {
        const [sw, sh] = srcDims();
        const N = +$('animFrames').value;
        const delay = Math.max(2, Math.round(100 / +$('animFps').value));
        for (let i = 0; i < N; i++) {
          const r = ditherSource(state.image, sw, sh, s, { jitter: 20, phase: i });
          W = r.w; H = r.h;
          frames.push({ data: r.out.data, delayCs: delay });
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
        const { out } = ditherSource(img, img.naturalWidth, img.naturalHeight, s);
        const blob = await upscaleImageDataToBlob(out, s.exportScale);
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

    const labels = $('duoWrap').querySelectorAll('.swatch span');
    if (s.mode === 'grayscale') { labels[0].textContent = 'Dark tint'; labels[1].textContent = 'Light tint'; }
    else { labels[0].textContent = 'Ink'; labels[1].textContent = 'Paper'; }
  }

  function refreshGifInfo() {
    const info = $('gifInfo');
    if (state.video) {
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
    SLIDERS.forEach((id) => { const el = $(id), out = $(id + 'Out'); if (el && out) out.textContent = el.value; });
  }

  /* ---------- reset / randomize ----------------------------------------- */
  function applyDefaults() {
    $('resolution').value = DEFAULTS.resolution;
    ['brightness', 'contrast', 'midtones', 'saturation', 'hue', 'scanlines', 'noise', 'chroma'].forEach((id) => { $(id).value = 0; });
    $('invert').checked = false;
    $('algorithm').value = DEFAULTS.algorithm; $('amount').value = 100;
    $('halftoneSize').value = 6; $('serpentine').checked = true;
    $('mode').value = DEFAULTS.mode; $('levels').value = 2; $('palette').value = DEFAULTS.palette;
    $('inkColor').value = DEFAULTS.ink; $('paperColor').value = DEFAULTS.paper;
    $('animFrames').value = DEFAULTS.animFrames; $('animFps').value = DEFAULTS.animFps;
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

  /* ---------- wiring ----------------------------------------------------- */
  function init() {
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

    // misc
    $('resetBtn').addEventListener('click', () => { applyDefaults(); schedule(); });
    $('randomBtn').addEventListener('click', randomize);
    $('showOriginal').addEventListener('change', schedule);
    window.addEventListener('resize', () => { if (state.lastOutput) fitCanvas(state.lastOutput.w, state.lastOutput.h); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
