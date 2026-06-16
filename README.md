# Ditherer

A self-contained, **in-browser** dithering studio. Upload an image or a video,
tweak the dither, download the result. Everything runs locally — your files
never leave your machine and there is no install, build step, or dependency.

## Run it

**Option A — just open it.** Double-click `index.html`. It works straight from
`file://` (no server needed).

**Option B — serve it** (recommended; enables "Copy to clipboard" in some
browsers and avoids any local-file quirks):

```bash
# from inside the project folder
python -m http.server 8000
# then open http://localhost:8000
```

## Features

**Input** — drag & drop, file picker, or paste from clipboard (Ctrl/Cmd+V).
Still images, animated GIFs and video clips (anything your browser can play —
MP4, WebM, …) are all accepted.

**Crop & straighten** — aspect-ratio presets (1:1, 4:5, 3:4, 2:3, 9:16 story,
5:4, 4:3, 3:2, 16:9), fine rotation from −45° to +45° in 0.1° steps with
auto-fit (straightening never exposes blank corners), 90° rotation buttons,
and zoom-to-reframe: zoom past 1× and drag the preview to position the crop.
A rule-of-thirds grid appears while you adjust. Applies to stills, GIFs and
video alike — all exports included.

**Live camera** — turn on your webcam and watch every effect apply in real
time: algorithm, palette, adjustments, crop/straighten, post effects — all
live. Pick a device if you have several, toggle the selfie mirror, save a
snapshot PNG, or record the live dithered preview straight to WebM. Stopping
the camera keeps the last frame as the working image so you can keep editing
it. Camera access needs https or localhost, and nothing ever leaves your
machine.

**Settings presets** — save the entire control state (dither, color, custom
palette, adjustments, crop/straighten, animation and export options) under a
name and reapply it to any image later; saved presets persist in the browser.
Presets also download as small `.ditherer.json` files you can share or back
up — import one with the Import button, or just drop the file anywhere on the
app and every setting snaps into place.

**18 dithering algorithms**
- *Error diffusion:* Floyd–Steinberg, False Floyd–Steinberg, Jarvis–Judice–Ninke,
  Stucki, Atkinson, Burkes, Sierra (3-row), Two-Row Sierra, Sierra Lite, Stevenson–Arce
- *Ordered:* Bayer 2×2 / 4×4 / 8×8, Clustered-dot 4×4 / 8×8
- *Pattern:* Halftone dots, Random noise, Threshold (no dither)

**Color**
- Black & White (1-bit) with custom ink/paper colors
- Grayscale / Duotone with an adjustable number of levels (2–32) and tinting
- Retro hardware palettes: NES (8-bit, 56 colors), EGA/VGA 16, CGA (×2),
  Game Boy & Game Boy Pocket, Apple II hi-res, MSX (TMS9918), Amstrad CPC (27),
  ZX Spectrum, Commodore 64, Amiga Workbench, PICO-8, CMYK, Sepia
- Build a **custom palette** by hand, or **extract** a palette from the image
  (median-cut, 2–32 colors)

**Adjustments (pre-dither)** — brightness, contrast, midtones (gamma),
saturation, hue shift, invert.

**Controls** — resolution / pixelation, dither amount (error scale / threshold
spread), serpentine scan, halftone dot size. Every dial has an **editable
number box** — type an exact value or drag the slider.

**Post effects** — glow/bloom (soft halo around bright pixels), signal warp
(analog wave wobble with glowing horizontal light-trail bleed, for that
neon-broadcast look), scanlines, noise, and chromatic aberration.

**Export** — download PNG at 1× / 2× / 4× / 8× (crisp nearest-neighbour upscale),
or copy straight to the clipboard. Live preview updates as you drag sliders.

**Output size & fill** — render to a fixed standard size (720p, 1080p, 1440p,
4K, 1080² square, 1080×1920 vertical, 4:5, social card, 4:3, or any custom
W×H) instead of native pixels. When the image doesn't match the target aspect,
choose **Contain** (letterbox/pillarbox padded with a fill color), **Cover**
(crop to fill) or **Stretch**. The fill color takes a hex code or can be
**eyedropped straight from the picture** — click ⌖ Pick, then click anywhere on
the preview. Output size applies to PNG, batch, GIF and video exports alike.

**Animated GIF** — load an animated GIF and every frame is re-dithered with your
current settings, then exported as a new looping GIF (original frame delays
preserved). Or turn a *still* image into an animated GIF: the "shimmer" generator
renders N frames with a moving/boiling dither pattern at an adjustable frame rate
— echoing the original's "temporal" effects. GIF encoding and decoding are both
implemented from scratch (no libraries).

**Video** — load a video clip and the live preview dithers it in real time while
it plays, with play/pause and a seek bar. Export options:
- **MP4 (H.264)** — frame-accurate encode through the WebCodecs `VideoEncoder`,
  wrapped in an MP4 container by a from-scratch ISO-BMFF muxer. Selectable
  frame rate (12/15/24/30 fps). Silent (no audio track) — ready for Instagram
  & co. Needs a WebCodecs browser (Chrome, Edge, Safari 16.4+, Firefox 130+).
- **WebM** — records the live preview via `MediaRecorder` in real time (the
  export takes as long as the clip), original audio included where the browser
  supports capturing it. Tweaking sliders *during* the recording is captured
  too — you can perform the export live.
- **Animated GIF** — samples the video timeline at your chosen fps (up to 200
  frames) and re-dithers every sampled frame.

**Batch processing** — queue any number of images, dither them all with the
current settings, and download the results as a single `.zip` (also written from
scratch, no libraries).

## Files

| file | purpose |
|------|---------|
| `index.html` | layout & controls |
| `style.css`  | styling |
| `dither.js`  | the processing engine (algorithms, palettes, effects) |
| `codec.js`   | animated GIF encoder/decoder, ZIP writer, MP4 muxer (all from scratch) |
| `app.js`     | UI wiring & render pipeline |

## Notes

Everything is implemented from scratch in vanilla JS on the Canvas API — no
libraries, no build step. Video in/out is supported: live dithered playback
plus MP4, WebM and GIF export. MP4 comes out silent (browsers don't expose an
AAC encoder reliably); pick WebM when you need the soundtrack.
