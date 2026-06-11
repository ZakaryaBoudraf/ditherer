/* ============================================================================
   Ditherer — codecs: animated GIF (encode + decode), ZIP (store), MP4 mux.
   Pure client-side, no dependencies. Exposes a global `Codec` object.
   GIF LZW encode/decode growth rules are matched (validated by round-trip).
   ========================================================================== */
(function (global) {
  'use strict';

  /* ====================== CRC32 (for ZIP) ============================== */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ====================== ZIP (store / no compression) ================= */
  // files: [{ name:string, data:Uint8Array }]  ->  Blob
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const DATE = 0x21; // 1980-01-01
    const TIME = 0;
    const push = (bytes) => { parts.push(bytes); offset += bytes.length; };
    const hdr = (arr) => Uint8Array.from(arr);
    const u16 = (v) => [v & 255, (v >> 8) & 255];
    const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = hdr([
        0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
        ...u16(TIME), ...u16(DATE), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0),
      ]);
      const localOffset = offset;
      push(local); push(name); push(data);
      central.push({ name, crc, size: data.length, offset: localOffset });
    }

    const cdStart = offset;
    for (const c of central) {
      const h = hdr([
        0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(TIME), ...u16(DATE), ...u32(c.crc), ...u32(c.size), ...u32(c.size),
        ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(c.offset),
      ]);
      push(h); push(c.name);
    }
    const cdSize = offset - cdStart;
    const eocd = hdr([
      0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(cdSize), ...u32(cdStart), ...u16(0),
    ]);
    push(eocd);
    return new Blob(parts, { type: 'application/zip' });
  }

  /* ====================== GIF LZW ===================================== */
  function lzwEncode(indices, minCodeSize) {
    const clear = 1 << minCodeSize, eoi = clear + 1;
    let codeSize, next, dict;
    const reset = () => {
      dict = new Map();
      for (let i = 0; i < clear; i++) dict.set('' + i, i);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    };
    const out = [];
    let cur = 0, n = 0;
    const emit = (code) => {
      cur |= code << n; n += codeSize;
      while (n >= 8) { out.push(cur & 0xFF); cur >>= 8; n -= 8; }
    };
    reset();
    emit(clear);
    if (indices.length === 0) { emit(eoi); if (n > 0) out.push(cur & 0xFF); return out; }
    let w = '' + indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const wc = w + ',' + k;
      if (dict.has(wc)) { w = wc; continue; }
      emit(dict.get(w));
      if (next === 4096) { emit(clear); reset(); }
      else {
        dict.set(wc, next);
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
        next++;
      }
      w = '' + k;
    }
    emit(dict.get(w));
    emit(eoi);
    if (n > 0) out.push(cur & 0xFF);
    return out;
  }

  function lzwDecode(data, minCodeSize, pixelCount) {
    const out = new Uint8Array(pixelCount);
    const clear = 1 << minCodeSize, eoi = clear + 1;
    let codeSize, dict;
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([]);   // clear slot
      dict.push(null); // eoi slot
      codeSize = minCodeSize + 1;
    };
    reset();
    let bitPos = 0, outPos = 0, prev = null;
    const total = data.length * 8;
    const read = () => {
      let code = 0;
      for (let i = 0; i < codeSize; i++) {
        const bi = bitPos >> 3;
        if (bi >= data.length) return eoi;
        code |= ((data[bi] >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return code;
    };
    while (bitPos + codeSize <= total) {
      const code = read();
      if (code === clear) { reset(); prev = null; continue; }
      if (code === eoi) break;
      let entry;
      if (code < dict.length) { entry = dict[code]; if (entry === null) break; }
      else if (code === dict.length && prev) { entry = prev.concat(prev[0]); }
      else break;
      for (let i = 0; i < entry.length && outPos < pixelCount; i++) out[outPos++] = entry[i];
      if (prev !== null) {
        dict.push(prev.concat(entry[0]));
        if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
      if (outPos >= pixelCount) break;
    }
    return out;
  }

  /* ====================== GIF palette quantization ==================== */
  // build a <=256 colour global palette + per-frame index arrays from RGBA frames
  function palettizeFrames(frames) {
    const map = new Map();
    let over = false;
    for (const f of frames) {
      const d = f.data;
      for (let i = 0; i < d.length; i += 4) {
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (!map.has(key)) { map.set(key, map.size); if (map.size > 256) { over = true; break; } }
      }
      if (over) break;
    }

    let palette, lookup;
    if (!over) {
      palette = new Array(map.size);
      for (const [key, idx] of map) palette[idx] = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
      lookup = (r, g, b) => map.get((r << 16) | (g << 8) | b) | 0;
    } else {
      // median-cut a global palette from a sample of all frames
      let totalPx = 0;
      for (const f of frames) totalPx += f.data.length / 4;
      const step = Math.max(1, Math.floor(totalPx / 30000));
      const sample = [];
      let cnt = 0;
      for (const f of frames) {
        const d = f.data;
        for (let i = 0; i < d.length; i += 4) {
          if ((cnt++ % step) !== 0) continue;
          sample.push(d[i], d[i + 1], d[i + 2], 255);
        }
      }
      palette = global.Dither.extractPalette({ data: new Uint8ClampedArray(sample) }, 256);
      const cache = new Map();
      lookup = (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        let best = 0, bd = Infinity;
        for (let i = 0; i < palette.length; i++) {
          const p = palette[i];
          const dr = r - p[0], dg = g - p[1], db = b - p[2];
          const dist = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
          if (dist < bd) { bd = dist; best = i; }
        }
        cache.set(key, best);
        return best;
      };
    }

    const indicesFrames = frames.map((f) => {
      const d = f.data, n = d.length / 4, idx = new Uint8Array(n);
      for (let i = 0; i < n; i++) idx[i] = lookup(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
      return idx;
    });
    return { palette, indicesFrames };
  }

  /* ====================== GIF encode ================================== */
  // width, height; frames: [{ data:RGBA Uint8(Clamped)Array, delayCs:int }]; opts {loop}
  function encodeGIF(width, height, frames, opts) {
    opts = opts || {};
    const loop = opts.loop == null ? 0 : opts.loop;
    const { palette, indicesFrames } = palettizeFrames(frames);

    let colorBits = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
    if (colorBits > 8) colorBits = 8;
    const gctEntries = 1 << colorBits;
    const minCodeSize = colorBits;
    const pal = palette.slice();
    while (pal.length < gctEntries) pal.push([0, 0, 0]);

    const bytes = [];
    const u8 = (v) => bytes.push(v & 255);
    const u16 = (v) => { bytes.push(v & 255, (v >> 8) & 255); };
    const str = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };

    str('GIF89a');
    u16(width); u16(height);
    u8(0x80 | ((colorBits - 1) << 4) | (colorBits - 1)); // GCT present + sizes
    u8(0); // background colour index
    u8(0); // pixel aspect ratio
    for (const c of pal) { u8(c[0]); u8(c[1]); u8(c[2]); }

    // Netscape looping extension
    u8(0x21); u8(0xFF); u8(11); str('NETSCAPE2.0'); u8(3); u8(1); u16(loop); u8(0);

    for (let f = 0; f < frames.length; f++) {
      const delay = Math.max(2, frames[f].delayCs | 0);
      // graphic control extension
      u8(0x21); u8(0xF9); u8(4); u8(0x04 /* disposal=1 */); u16(delay); u8(0); u8(0);
      // image descriptor (full frame, no local table, no interlace)
      u8(0x2C); u16(0); u16(0); u16(width); u16(height); u8(0);
      u8(minCodeSize);
      const lzw = lzwEncode(indicesFrames[f], minCodeSize);
      // image data sub-blocks
      let i = 0;
      while (i < lzw.length) {
        const n = Math.min(255, lzw.length - i);
        u8(n);
        for (let j = 0; j < n; j++) u8(lzw[i + j]);
        i += n;
      }
      u8(0);
    }
    u8(0x3B); // trailer
    return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
  }

  /* ====================== GIF decode ================================== */
  function decodeGIF(buffer) {
    const b = new Uint8Array(buffer);
    if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new Error('Not a GIF');
    let p = 6;
    const u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
    const width = u16(), height = u16();
    const packed = b[p++]; p++; /* bg */ p++; /* aspect */
    let gct = null;
    if (packed & 0x80) {
      const size = 2 << (packed & 7);
      gct = new Array(size);
      for (let i = 0; i < size; i++) { gct[i] = [b[p], b[p + 1], b[p + 2]]; p += 3; }
    }

    const canvas = new Uint8ClampedArray(width * height * 4); // transparent
    const frames = [];
    let gce = null;
    let saved = null;

    while (p < b.length) {
      const block = b[p++];
      if (block === 0x3B) break;            // trailer
      if (block === 0x21) {                 // extension
        const label = b[p++];
        if (label === 0xF9) {               // graphic control
          p++; // block size (4)
          const pk = b[p++];
          const delay = u16();
          const tindex = b[p++];
          p++; // terminator
          gce = { disposal: (pk >> 2) & 7, transparent: !!(pk & 1), tindex, delayCs: delay };
        } else {                            // skip other extensions
          let s; while ((s = b[p++]) !== 0) p += s;
        }
      } else if (block === 0x2C) {          // image descriptor
        const ix = u16(), iy = u16(), iw = u16(), ih = u16();
        const ip = b[p++];
        let ct = gct;
        if (ip & 0x80) {
          const size = 2 << (ip & 7);
          ct = new Array(size);
          for (let i = 0; i < size; i++) { ct[i] = [b[p], b[p + 1], b[p + 2]]; p += 3; }
        }
        const interlace = !!(ip & 0x40);
        const minCode = b[p++];
        const lzwBytes = [];
        let s; while ((s = b[p++]) !== 0) { for (let i = 0; i < s; i++) lzwBytes.push(b[p++]); }
        const indices = lzwDecode(new Uint8Array(lzwBytes), minCode, iw * ih);

        const disposal = gce ? gce.disposal : 0;
        if (disposal === 3) saved = canvas.slice();
        const transparent = (gce && gce.transparent) ? gce.tindex : -1;

        // composite (with interlace de-ordering)
        const rows = [];
        if (interlace) {
          for (const [start, stepv] of [[0, 8], [4, 8], [2, 4], [1, 2]])
            for (let r = start; r < ih; r += stepv) rows.push(r);
        } else {
          for (let r = 0; r < ih; r++) rows.push(r);
        }
        let src = 0;
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          for (let col = 0; col < iw; col++) {
            const idx = indices[src++];
            if (idx === transparent) continue;
            const c = ct && ct[idx];
            if (!c) continue;
            const X = ix + col, Y = iy + row;
            if (X >= width || Y >= height) continue;
            const o = (Y * width + X) * 4;
            canvas[o] = c[0]; canvas[o + 1] = c[1]; canvas[o + 2] = c[2]; canvas[o + 3] = 255;
          }
        }

        frames.push({ data: canvas.slice(), delayCs: gce ? gce.delayCs : 0 });

        if (disposal === 2) {               // restore rect to background (transparent)
          for (let yy = 0; yy < ih; yy++) {
            for (let xx = 0; xx < iw; xx++) {
              const X = ix + xx, Y = iy + yy;
              if (X >= width || Y >= height) continue;
              const o = (Y * width + X) * 4;
              canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
            }
          }
        } else if (disposal === 3 && saved) {
          canvas.set(saved);
        }
        gce = null;
      } else {
        break; // unknown block — stop gracefully
      }
    }
    return { width, height, frames };
  }

  /* ====================== MP4 mux (H.264, video-only) ================== */
  // Wraps WebCodecs-encoded H.264 (AVC format) samples in an ISO BMFF container.
  // opts: { width, height, fps, samples:[{data:Uint8Array,isKey:bool}], avcC:Uint8Array }
  function muxMP4(opts) {
    const { width, height, fps, samples, avcC } = opts;
    const enc = new TextEncoder();
    const cat = (arrs) => {
      let n = 0;
      for (const a of arrs) n += a.length;
      const o = new Uint8Array(n);
      let p = 0;
      for (const a of arrs) { o.set(a, p); p += a.length; }
      return o;
    };
    const U32 = (v) => Uint8Array.from([v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255]);
    const U16 = (v) => Uint8Array.from([v >>> 8 & 255, v & 255]);
    const STR = (s) => enc.encode(s);
    const box = (type, ...parts) => {
      const body = cat(parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));
      return cat([U32(body.length + 8), STR(type), body]);
    };
    const full = (type, version, flags, ...parts) =>
      box(type, Uint8Array.from([version, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255]), ...parts);

    const TS = 90000;                          // track timescale
    const delta = Math.round(TS / fps);
    const n = samples.length;
    const durMs = Math.round((n * 1000) / fps);
    const MATRIX = cat([U32(0x10000), U32(0), U32(0), U32(0), U32(0x10000), U32(0),
                        U32(0), U32(0), U32(0x40000000)]);

    const ftyp = box('ftyp', STR('isom'), U32(512), STR('isomiso2avc1mp41'));
    const mediaData = cat(samples.map((s) => s.data));
    const mdat = cat([U32(mediaData.length + 8), STR('mdat'), mediaData]);
    const dataOffset = ftyp.length + 8;        // first sample byte in the file

    let keyIdx = [];
    samples.forEach((s, i) => { if (s.isKey) keyIdx.push(i + 1); });
    if (!keyIdx.length) keyIdx = [1];

    const avc1 = box('avc1',
      new Uint8Array(6), U16(1),               // reserved + data_reference_index
      new Uint8Array(16),                      // pre_defined / reserved
      U16(width), U16(height),
      U32(0x00480000), U32(0x00480000),        // 72 dpi
      U32(0), U16(1),                          // reserved + frame_count
      new Uint8Array(32),                      // compressorname
      U16(0x0018), U16(0xFFFF),                // depth + pre_defined(-1)
      box('avcC', avcC));

    const stbl = box('stbl',
      full('stsd', 0, 0, U32(1), avc1),
      full('stts', 0, 0, U32(1), U32(n), U32(delta)),
      full('stss', 0, 0, U32(keyIdx.length), cat(keyIdx.map(U32))),
      full('stsc', 0, 0, U32(1), U32(1), U32(n), U32(1)),
      full('stsz', 0, 0, U32(0), U32(n), cat(samples.map((s) => U32(s.data.length)))),
      full('stco', 0, 0, U32(1), U32(dataOffset)));

    const minf = box('minf',
      full('vmhd', 0, 1, U16(0), U16(0), U16(0), U16(0)),
      box('dinf', full('dref', 0, 0, U32(1), full('url ', 0, 1))),
      stbl);

    const mdia = box('mdia',
      full('mdhd', 0, 0, U32(0), U32(0), U32(TS), U32(n * delta), U16(0x55C4), U16(0)),
      full('hdlr', 0, 0, U32(0), STR('vide'), U32(0), U32(0), U32(0), STR('VideoHandler'), new Uint8Array(1)),
      minf);

    const tkhd = full('tkhd', 0, 3,
      U32(0), U32(0), U32(1), U32(0), U32(durMs),
      U32(0), U32(0), U16(0), U16(0), U16(0), U16(0), MATRIX,
      U32(width << 16), U32(height << 16));

    const mvhd = full('mvhd', 0, 0,
      U32(0), U32(0), U32(1000), U32(durMs), U32(0x10000), U16(0x0100), U16(0),
      U32(0), U32(0), MATRIX,
      U32(0), U32(0), U32(0), U32(0), U32(0), U32(0), U32(2));

    const moov = box('moov', mvhd, box('trak', tkhd, mdia));
    return new Blob([ftyp, mdat, moov], { type: 'video/mp4' });
  }

  /* ====================== exports ===================================== */
  global.Codec = { crc32, zipStore, encodeGIF, decodeGIF, muxMP4, _lzwEncode: lzwEncode, _lzwDecode: lzwDecode };
})(window);
