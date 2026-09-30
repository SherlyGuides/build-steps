// Photo editor for step photos: crop, rotate, straighten, adjust, and mark (arrows, circles,
// boxes). Edits never touch the original; the photo on the slide is rendered from
// original + edits, so a photo can be re-edited any time without losing quality.
//
// edits = {
//   rotate: 0 | 90 | 180 | 270, flip: bool, straighten: -15..15 (degrees),
//   crop: { x, y, w, h } (0–1, in the rotated picture) | null,
//   adjust: { brightness, contrast, saturation, warmth, whites, sharpen, lo, hi },
//   marks: [{ type: "arrow" | "circle" | "box", color, size, x1, y1, x2, y2 }] (0–1, in the original;
//          size is the line thickness, 1 = normal),
//   cutout: { bg: "#FFFFFF", edge: -50..50 } | null   background removed; the mask is stored beside
// }                                                   the photo (a PNG whose alpha is the subject)

import { LAYOUT } from "./deck.js";
import { backend, findSubject, modelDownloaded } from "./bg-remove.js";

export const OUTPUT_SIDE = 1600;
const PREVIEW_SIDE = 1400;

export const NEUTRAL_ADJUST = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, whites: 0, sharpen: 0, lo: 0, hi: 255 };
export const blankEdits = () => ({ rotate: 0, flip: false, straighten: 0, crop: null, adjust: { ...NEUTRAL_ADJUST }, marks: [], cutout: null });

const BACKGROUNDS = [{ color: "#FFFFFF", label: "White" }, { color: "#F2F2F2", label: "Light grey" }, { color: "#FBF4EA", label: "Warm" }];
const REMOVED_TINT = "#F29B9B";

const ASPECTS = [
  { id: "free", label: "Free", ratio: null },
  { id: "slide", label: "Slide", ratio: LAYOUT.photo.w / LAYOUT.photo.h },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
];
const SLIDERS = [
  { key: "brightness", label: "Brightness", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "warmth", label: "Warmth", min: -100, max: 100 },
  { key: "whites", label: "Whites", min: 0, max: 100, hint: "Turns a grey table or sheet white" },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100 },
];
const COLORS = ["#FF2D2D", "#FFD400", "#1E7BFF", "#FFFFFF"];
const BRUSHES = [{ id: "", label: "Off" }, { id: "erase", label: "🧽 Erase" }, { id: "restore", label: "🖌 Restore" }];
const THICKNESS = [{ size: 0.6, label: "Thin" }, { size: 1, label: "Normal" }, { size: 1.6, label: "Thick" }, { size: 2.4, label: "Extra thick" }];
const TOOLS = [{ id: "arrow", label: "➚ Arrow" }, { id: "circle", label: "◯ Circle" }, { id: "box", label: "▢ Box" }];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function loadBlobImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The photo could not be opened.")); };
    img.src = url;
  });
}

/** The matte after the Edge setting: negative keeps more around the subject, positive less. */
function edgeMask(mask, edge) {
  if (!edge) return mask;
  const out = Object.assign(document.createElement("canvas"), { width: mask.width, height: mask.height });
  const octx = out.getContext("2d");
  octx.drawImage(mask, 0, 0);
  const image = octx.getImageData(0, 0, out.width, out.height), d = image.data;
  const shift = edge / 250, gain = 1 + Math.abs(edge) / 25, lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v / 255 - 0.5 - shift) * gain + 0.5) * 255;
  for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]];
  octx.putImageData(image, 0, 0);
  return out;
}

// One cached composite per mask: rebuilding it for every slider move would be slow.
const cutoutCache = new WeakMap();
function cutoutSource(img, mask, cutout, side, bg) {
  const key = `${mask.dataset?.version ?? 0}|${cutout.edge}|${side}|${bg}`;
  const hit = cutoutCache.get(mask);
  if (hit?.key === key) return hit.canvas;
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const subject = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const sctx = subject.getContext("2d");
  sctx.drawImage(img, 0, 0, w, h);
  sctx.globalCompositeOperation = "destination-in";
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(edgeMask(mask, cutout.edge), 0, 0, w, h);
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const cctx = canvas.getContext("2d");
  cctx.fillStyle = bg;
  cctx.fillRect(0, 0, w, h);
  cctx.drawImage(subject, 0, 0);
  cutoutCache.set(mask, { key, canvas });
  return canvas;
}

/** Size of the rotated picture and the matrix from original pixels into it. */
function geometry(ow, oh, e) {
  const angle = ((e.rotate + e.straighten) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  const W = ow * cos + oh * sin, H = ow * sin + oh * cos;
  const M = new DOMMatrix().translate(W / 2, H / 2).rotate(e.rotate + e.straighten).scale(e.flip ? -1 : 1, 1).translate(-ow / 2, -oh / 2);
  return { W, H, M };
}

/** Draw original + geometry (+ crop unless full) into a canvas no bigger than maxSide. */
function renderBase(img, e, maxSide, { full = false, mask = null, bg = null } = {}) {
  const ow = img.naturalWidth, oh = img.naturalHeight;
  const { W, H, M } = geometry(ow, oh, e);
  const c = full || !e.crop ? { x: 0, y: 0, w: 1, h: 1 } : e.crop;
  const cx = c.x * W, cy = c.y * H, cw = c.w * W, ch = c.h * H;
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * s));
  canvas.height = Math.max(1, Math.round(ch * s));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const T = new DOMMatrix().scale(s).translate(-cx, -cy).multiply(M);
  ctx.setTransform(T);
  ctx.imageSmoothingQuality = "high";
  if (e.cutout && mask) {
    ctx.fillStyle = bg ?? e.cutout.bg;
    ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(cutoutSource(img, mask, e.cutout, Math.max(canvas.width, canvas.height) / s, bg ?? e.cutout.bg), 0, 0, ow, oh);
  } else {
    ctx.drawImage(img, 0, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, ctx, T, ow, oh };
}

const neutral = a => SLIDERS.every(s => !a[s.key]) && (a.lo ?? 0) === 0 && (a.hi ?? 255) === 255;

function applyAdjust(ctx, width, height, a) {
  if (neutral(a)) return;
  const image = ctx.getImageData(0, 0, width, height), d = image.data;
  const lo = a.lo ?? 0, hi = Math.max(lo + 1, a.hi ?? 255);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = ((v - lo) * 255) / (hi - lo);
    x += a.brightness * 0.8;
    x = (x - 128) * (1 + a.contrast / 100) + 128;
    lut[v] = x;
  }
  const sat = 1 + a.saturation / 100, warm = a.warmth * 0.25;
  const threshold = 255 - a.whites * 1.6;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    if (warm) { r += warm; b -= warm; }
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    }
    if (a.whites) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      let t = (l - threshold) / 40;
      if (t > 0) {
        t = t >= 1 ? 1 : t * t * (3 - 2 * t);
        r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t;
      }
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  if (a.sharpen) {
    const src = new Uint8ClampedArray(d), k = a.sharpen / 100, row = width * 4;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * row + x * 4;
        for (let c = 0; c < 3; c++) {
          const v = src[i + c];
          d[i + c] = v + k * (4 * v - src[i + c - 4] - src[i + c + 4] - src[i + c - row] - src[i + c + row]);
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

function drawMark(ctx, mark, T, ow, oh, size) {
  const p1 = T.transformPoint(new DOMPoint(mark.x1 * ow, mark.y1 * oh));
  const p2 = T.transformPoint(new DOMPoint(mark.x2 * ow, mark.y2 * oh));
  const w = Math.max(2, size * 0.011 * (mark.size ?? 1));
  const light = mark.color === "#FFFFFF" || mark.color === "#FFD400";
  const outline = light ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.9)";
  const path = () => {
    ctx.beginPath();
    if (mark.type === "arrow") {
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x), head = w * 4.2;
      const bx = p2.x - Math.cos(angle) * head * 0.8, by = p2.y - Math.sin(angle) * head * 0.8;
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(bx, by);
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - head * Math.cos(angle - 0.5), p2.y - head * Math.sin(angle - 0.5));
      ctx.lineTo(p2.x - head * Math.cos(angle + 0.5), p2.y - head * Math.sin(angle + 0.5));
      ctx.closePath();
    } else if (mark.type === "circle") {
      ctx.ellipse((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, Math.max(1, Math.abs(p2.x - p1.x) / 2), Math.max(1, Math.abs(p2.y - p1.y) / 2), 0, 0, Math.PI * 2);
    } else {
      ctx.roundRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y), w * 1.5);
    }
  };
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  path(); ctx.strokeStyle = outline; ctx.lineWidth = w * 1.9; ctx.stroke();
  if (mark.type === "arrow") { ctx.fillStyle = outline; ctx.fill(); }
  path(); ctx.strokeStyle = mark.color; ctx.lineWidth = w; ctx.stroke();
  if (mark.type === "arrow") { ctx.fillStyle = mark.color; ctx.fill(); }
  ctx.restore();
}

function render(img, e, maxSide, options) {
  const base = renderBase(img, e, maxSide, options);
  const { canvas, ctx, T, ow, oh } = base;
  applyAdjust(ctx, canvas.width, canvas.height, e.adjust);
  if (!options?.full) for (const mark of e.marks) drawMark(ctx, mark, T, ow, oh, Math.max(canvas.width, canvas.height));
  return base;
}

/** The photo that goes on the slide: original + edits, JPEG, at most 1600 px. */
export async function renderPhoto(originalBlob, edits = blankEdits(), maskBlob = null) {
  const img = await loadBlobImage(originalBlob);
  const mask = edits.cutout && maskBlob ? await loadBlobImage(maskBlob) : null;
  const { canvas } = render(img, edits, OUTPUT_SIDE, { mask });
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  return { blob, w: canvas.width, h: canvas.height };
}

/** Levels and a little colour and sharpness, measured from the picture itself. */
function autoAdjust(img, e, mask) {
  const { canvas, ctx } = renderBase(img, e, 320, { mask });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  const total = d.length / 4, pick = share => { let n = 0; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= total * share) return v; } return 255; };
  const lo = Math.min(60, pick(0.005)), hi = Math.max(lo + 60, Math.max(190, pick(0.995)));
  return { ...NEUTRAL_ADJUST, lo, hi, saturation: 12, sharpen: 25, whites: 15 };
}

// ---------------------------------------------------------------------------
// Editor screen
// ---------------------------------------------------------------------------

const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function maskCanvas(blob) {
  const image = await loadBlobImage(blob);
  const canvas = Object.assign(document.createElement("canvas"), { width: image.naturalWidth, height: image.naturalHeight });
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

/**
 * Open the editor full screen. Resolves to { blob, w, h, edits, maskBlob } when the user taps
 * Done (maskBlob only when the cut-out changed), or null on Cancel.
 */
export async function editPhoto(originalBlob, startEdits, maskBlob = null, { slideAspect = LAYOUT.photo.w / LAYOUT.photo.h } = {}) {
  // "Slide" crops to the exact shape of this step's photo area, which depends on its part/photo split.
  const aspects = ASPECTS.map(a => a.id === "slide" ? { ...a, ratio: slideAspect } : a);
  const img = await loadBlobImage(originalBlob);
  let e = structuredClone({ ...blankEdits(), ...startEdits, adjust: { ...NEUTRAL_ADJUST, ...startEdits?.adjust } });
  let mask = maskBlob ? await maskCanvas(maskBlob) : null, maskChanged = false, maskVersion = 0;
  if (!mask) e.cutout = null;
  const maskHistory = [];
  const history = [];
  let tab = "crop", slider = "brightness", tool = "arrow", color = COLORS[0], aspect = "free";
  let brush = "", brushSize = 30, highlight = false, working = false, thickness = 1;

  const root = document.createElement("div");
  root.className = "pe";
  root.innerHTML = `
    <header class="pe-top">
      <button class="pe-text" data-act="cancel">Cancel</button>
      <span class="pe-title">Edit photo</span>
      <button class="pe-icon" data-act="undo" aria-label="Undo">↶</button>
      <button class="pe-done" data-act="done">Done</button>
    </header>
    <div class="pe-stage"><div class="pe-wrap"><canvas></canvas><div class="pe-crop" hidden>
      <div class="pe-box"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i><b></b><b></b></div>
    </div></div></div>
    <div class="pe-panel"></div>
    <div class="pe-busy" hidden><div><div class="spinner"></div><p></p><div class="pe-bar"><i></i></div></div></div>
    <nav class="pe-tabs">
      <button data-tab="crop">Crop</button><button data-tab="bg">Background</button><button data-tab="adjust">Adjust</button><button data-tab="mark">Mark</button>
    </nav>`;
  document.body.append(root);
  document.body.classList.add("pe-open");

  const stage = root.querySelector(".pe-stage"), wrap = root.querySelector(".pe-wrap");
  const canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
  const cropLayer = root.querySelector(".pe-crop"), cropBox = root.querySelector(".pe-box");
  const panel = root.querySelector(".pe-panel");
  let view = null; // { T, ow, oh } of what the canvas shows

  const snapshot = () => { history.push(structuredClone(e)); if (history.length > 60) history.shift(); updateUndo(); };
  const updateUndo = () => { root.querySelector('[data-act="undo"]').disabled = !history.length; };

  // Draw at most once per frame while sliders or fingers move.
  let pending = false;
  const redraw = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; paint(); });
  };

  function paint() {
    const box = stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxSide = Math.min(PREVIEW_SIDE, Math.max(box.width, box.height) * dpr);
    const out = render(img, e, maxSide, { full: tab === "crop", mask, bg: tab === "bg" && highlight ? REMOVED_TINT : null });
    view = out;
    canvas.width = out.canvas.width; canvas.height = out.canvas.height;
    ctx.drawImage(out.canvas, 0, 0);
    if (drawing) drawMark(ctx, drawing, out.T, out.ow, out.oh, Math.max(canvas.width, canvas.height));
    if (tab === "mark" && selected != null && e.marks[selected]) {
      const r = handleRadius();
      for (const pt of markPoints(e.marks[selected])) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = Math.max(2, r * 0.35); ctx.strokeStyle = "#1B242D"; ctx.stroke();
      }
    }
    const scale = Math.min((box.width - 24) / canvas.width, (box.height - 24) / canvas.height);
    wrap.style.width = `${canvas.width * scale}px`;
    wrap.style.height = `${canvas.height * scale}px`;
    cropLayer.hidden = tab !== "crop";
    if (tab === "crop") placeCrop();
  }

  // ----- crop box -----
  const crop = () => e.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const rotatedSize = () => { const g = geometry(img.naturalWidth, img.naturalHeight, e); return { W: g.W, H: g.H }; };
  function placeCrop() {
    const c = crop();
    Object.assign(cropBox.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
  }
  function setAspect(id) {
    aspect = id;
    const ratio = aspects.find(a => a.id === id).ratio;
    if (!ratio) return;
    snapshot();
    const { W, H } = rotatedSize();
    // Largest centred crop with this shape.
    let w = 1, h = (W / H) / ratio;
    if (h > 1) { w = ratio / (W / H); h = 1; }
    e.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  let dragging = null;
  cropLayer.addEventListener("pointerdown", ev => {
    const handle = ev.target.closest("[data-h]")?.dataset.h ?? (ev.target.closest(".pe-box") ? "move" : null);
    if (!handle) return;
    ev.preventDefault();
    snapshot();
    const rect = wrap.getBoundingClientRect();
    dragging = { handle, start: { ...crop() }, px: ev.clientX, py: ev.clientY, rect, id: ev.pointerId };
    cropLayer.setPointerCapture(ev.pointerId);
  });
  cropLayer.addEventListener("pointermove", ev => {
    if (!dragging || ev.pointerId !== dragging.id) return;
    const { handle, start, rect } = dragging;
    const dx = (ev.clientX - dragging.px) / rect.width, dy = (ev.clientY - dragging.py) / rect.height;
    const MIN = 0.06;
    if (handle === "move") {
      e.crop = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
    } else {
      const west = handle.includes("w"), north = handle.includes("n");
      const ax = west ? start.x + start.w : start.x, ay = north ? start.y + start.h : start.y; // fixed corner
      let px = clamp((west ? start.x : start.x + start.w) + dx, 0, 1), py = clamp((north ? start.y : start.y + start.h) + dy, 0, 1);
      let w = Math.max(MIN, Math.abs(px - ax)), h = Math.max(MIN, Math.abs(py - ay));
      const ratio = aspects.find(a => a.id === aspect).ratio;
      if (ratio) {
        const { W, H } = rotatedSize(), k = (W / H) / ratio; // h = w * k keeps the shape
        if (w * k > h) h = w * k; else w = h / k;
        const maxW = west ? ax : 1 - ax, maxH = north ? ay : 1 - ay;
        if (w > maxW) { w = maxW; h = w * k; }
        if (h > maxH) { h = maxH; w = h / k; }
      }
      e.crop = { x: west ? ax - w : ax, y: north ? ay - h : ay, w: Math.min(w, west ? ax : 1 - ax), h: Math.min(h, north ? ay : 1 - ay) };
    }
    placeCrop();
  });
  const endDrag = () => { if (dragging) { dragging = null; if (e.crop && e.crop.w > 0.995 && e.crop.h > 0.995) e.crop = null; } };
  cropLayer.addEventListener("pointerup", endDrag);
  cropLayer.addEventListener("pointercancel", endDrag);

  // ----- marks -----
  let drawing = null;
  const toOriginal = ev => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * canvas.width, y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
    const p = view.T.inverse().transformPoint(new DOMPoint(x, y));
    return { x: p.x / view.ow, y: p.y / view.oh };
  };
  // ----- erase / restore brush on the cut-out -----
  let painting = null;
  const toMask = ev => { const p = toOriginal(ev); return { x: p.x * mask.width, y: p.y * mask.height }; };
  const dab = (from, to) => {
    const mctx = mask.getContext("2d");
    const radius = (brushSize / 100) * 0.08 * Math.max(mask.width, mask.height) + 2;
    mctx.save();
    mctx.globalCompositeOperation = brush === "erase" ? "destination-out" : "source-over";
    mctx.strokeStyle = mctx.fillStyle = "#fff";
    mctx.lineCap = "round"; mctx.lineWidth = radius * 2;
    mctx.beginPath(); mctx.moveTo(from.x, from.y); mctx.lineTo(to.x, to.y); mctx.stroke();
    mctx.restore();
    mask.dataset.version = String(++maskVersion);
  };
  canvas.addEventListener("pointerdown", ev => {
    if (tab !== "bg" || !brush || !mask || !e.cutout) return;
    ev.preventDefault();
    maskHistory.push(mask.getContext("2d").getImageData(0, 0, mask.width, mask.height));
    if (maskHistory.length > 10) maskHistory.shift();
    painting = toMask(ev);
    dab(painting, painting);
    maskChanged = true;
    canvas.setPointerCapture(ev.pointerId);
    redraw();
  });
  canvas.addEventListener("pointermove", ev => {
    if (!painting) return;
    const p = toMask(ev);
    dab(painting, p);
    painting = p;
    redraw();
  });
  const endPaint = () => { if (painting) { painting = null; drawPanel(); } };
  canvas.addEventListener("pointerup", endPaint);
  canvas.addEventListener("pointercancel", endPaint);

  // ----- marks: draw, then select to resize, move, recolour or delete -----
  let selected = null, grab = null;   // grab: { kind: "p1" | "p2" | "move", start, from, moved }
  const toCanvas = ev => {
    const rect = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - rect.left) / rect.width) * canvas.width, y: ((ev.clientY - rect.top) / rect.height) * canvas.height };
  };
  const handleRadius = () => Math.max(canvas.width, canvas.height) * 0.016;
  const markPoints = m => [
    view.T.transformPoint(new DOMPoint(m.x1 * view.ow, m.y1 * view.oh)),
    view.T.transformPoint(new DOMPoint(m.x2 * view.ow, m.y2 * view.oh)),
  ];
  const segDistance = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  /** Index of the mark under a canvas point (last drawn wins), or null. */
  const markAt = cp => {
    const reach = Math.max(canvas.width, canvas.height) * 0.03;
    for (let i = e.marks.length - 1; i >= 0; i--) {
      const m = e.marks[i], [a, b] = markPoints(m);
      if (m.type === "arrow") { if (segDistance(cp, a, b) < reach) return i; continue; }
      const x0 = Math.min(a.x, b.x) - reach, x1 = Math.max(a.x, b.x) + reach, y0 = Math.min(a.y, b.y) - reach, y1 = Math.max(a.y, b.y) + reach;
      if (cp.x >= x0 && cp.x <= x1 && cp.y >= y0 && cp.y <= y1) return i;
    }
    return null;
  };
  const select = i => { selected = i; drawPanel(); redraw(); };

  canvas.addEventListener("pointerdown", ev => {
    if (tab !== "mark" || !view) return;   // nothing drawn yet
    ev.preventDefault();
    const cp = toCanvas(ev), p = toOriginal(ev);
    // A handle of the selected mark: resize / re-aim it.
    if (selected != null && e.marks[selected]) {
      const [a, b] = markPoints(e.marks[selected]), r = handleRadius() * 2;
      const kind = Math.hypot(cp.x - b.x, cp.y - b.y) < r ? "p2" : Math.hypot(cp.x - a.x, cp.y - a.y) < r ? "p1" : null;
      if (kind) { snapshot(); grab = { kind, moved: false }; canvas.setPointerCapture(ev.pointerId); return; }
    }
    // An existing mark: select it and start moving it.
    const hit = markAt(cp);
    if (hit != null) {
      snapshot();
      grab = { kind: "move", start: p, from: { ...e.marks[hit] }, moved: false };
      select(hit);
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    // Empty space: draw a new mark.
    selected = null;
    drawing = { type: tool, color, size: thickness, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", ev => {
    if (tab !== "mark" || !view) return;
    const p = toOriginal(ev);
    if (grab && selected != null) {
      const m = e.marks[selected];
      if (grab.kind === "p1") { m.x1 = p.x; m.y1 = p.y; }
      else if (grab.kind === "p2") { m.x2 = p.x; m.y2 = p.y; }
      else {
        const dx = p.x - grab.start.x, dy = p.y - grab.start.y;
        m.x1 = grab.from.x1 + dx; m.y1 = grab.from.y1 + dy; m.x2 = grab.from.x2 + dx; m.y2 = grab.from.y2 + dy;
      }
      grab.moved = true;
      redraw();
      return;
    }
    if (!drawing) return;
    drawing.x2 = p.x; drawing.y2 = p.y;
    redraw();
  });
  const finishMark = () => {
    if (grab) {
      if (!grab.moved) history.pop(), updateUndo();   // a plain tap only selects: nothing to undo
      grab = null;
      drawPanel(); redraw();
      return;
    }
    if (!drawing) return;
    const mark = drawing;
    drawing = null;
    const [a, b] = markPoints(mark);
    if (Math.hypot(a.x - b.x, a.y - b.y) > Math.max(canvas.width, canvas.height) * 0.03) {
      snapshot();
      e.marks.push(mark);
      selected = e.marks.length - 1;   // stays selected, so it can be adjusted straight away
    }
    drawPanel(); redraw();
  };
  canvas.addEventListener("pointerup", finishMark);
  canvas.addEventListener("pointercancel", () => { drawing = null; grab = null; redraw(); });

  // ----- panels -----
  function drawPanel() {
    root.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
    if (tab === "crop") {
      panel.innerHTML = `
        <div class="pe-row">
          <button class="pe-tool" data-act="rotl">↺<span>Rotate left</span></button>
          <button class="pe-tool" data-act="rotr">↻<span>Rotate right</span></button>
          <button class="pe-tool" data-act="flip">⇆<span>Mirror</span></button>
          <button class="pe-tool" data-act="resetcrop">↩<span>Reset</span></button>
        </div>
        <label class="pe-slider"><span>Straighten <b>${e.straighten > 0 ? "+" : ""}${e.straighten}°</b></span>
          <input type="range" min="-15" max="15" step="0.5" value="${e.straighten}" data-range="straighten"></label>
        <div class="pe-chips">${aspects.map(a => `<button class="pe-chip ${a.id === aspect ? "on" : ""}" data-aspect="${a.id}">${a.label}</button>`).join("")}</div>`;
    } else if (tab === "bg") {
      panel.innerHTML = !e.cutout ? `
        <button class="pe-big" data-act="removebg" ${working ? "disabled" : ""}>✂️ Remove background</button>
        <p class="pe-hint">AI finds the model and replaces everything else with plain white. It runs on this phone; the first time it downloads the AI model once.</p>
        ${mask ? `<div class="pe-row end"><button class="pe-text small" data-act="reusebg">Use the last cut-out again</button></div>` : ""}`
      : `
        <div class="pe-chips">
          ${BACKGROUNDS.map(b => `<button class="pe-chip swatch ${b.color === e.cutout.bg ? "on" : ""}" data-bg="${b.color}"><i style="background:${b.color}"></i>${b.label}</button>`).join("")}
          <button class="pe-chip ${highlight ? "on" : ""}" data-act="highlight">${highlight ? "✓ " : ""}Show removed area</button>
        </div>
        <label class="pe-slider"><span>Edge <b>${e.cutout.edge > 0 ? "+" : ""}${e.cutout.edge}</b><em>− keeps more around the model, + trims tighter</em></span>
          <input type="range" min="-50" max="50" step="1" value="${e.cutout.edge}" data-range="edge"></label>
        <div class="pe-chips">${BRUSHES.map(b => `<button class="pe-chip ${b.id === brush ? "on" : ""}" data-brush="${b.id}">${b.label}</button>`).join("")}
          <button class="pe-text small" data-act="brushundo" ${maskHistory.length ? "" : "disabled"}>Undo brush</button></div>
        ${brush ? `<label class="pe-slider"><span>Brush size <b>${brushSize}</b><em>Paint on the photo to ${brush === "erase" ? "remove more background" : "bring back part of the model"}</em></span>
          <input type="range" min="1" max="100" step="1" value="${brushSize}" data-range="brush"></label>` : ""}
        <div class="pe-row end"><button class="pe-text small" data-act="keepbg">Put the original background back</button></div>`;
    } else if (tab === "adjust") {
      const s = SLIDERS.find(x => x.key === slider);
      panel.innerHTML = `
        <div class="pe-chips scroll">
          <button class="pe-chip auto" data-act="auto">✨ Auto</button>
          ${SLIDERS.map(x => `<button class="pe-chip ${x.key === slider ? "on" : ""} ${e.adjust[x.key] ? "set" : ""}" data-slider="${x.key}">${x.label}${e.adjust[x.key] ? ` ${e.adjust[x.key] > 0 ? "+" : ""}${e.adjust[x.key]}` : ""}</button>`).join("")}
        </div>
        <label class="pe-slider"><span>${s.label} <b>${e.adjust[s.key]}</b>${s.hint ? `<em>${s.hint}</em>` : ""}</span>
          <input type="range" min="${s.min}" max="${s.max}" step="1" value="${e.adjust[s.key]}" data-range="${s.key}"></label>
        <div class="pe-row end"><button class="pe-text small" data-act="resetadjust" ${neutral(e.adjust) ? "disabled" : ""}>Reset adjustments</button></div>`;
    } else {
      const sel = selected != null ? e.marks[selected] : null;
      panel.innerHTML = `
        ${sel ? `<div class="pe-selected"><b>Selected ${TOOLS.find(t => t.id === sel.type).label.replace(/^\S+\s/, "").toLowerCase()}</b>
          <button class="pe-text small" data-act="deselect">Done</button></div>` : `
        <div class="pe-chips">${TOOLS.map(t => `<button class="pe-chip ${t.id === tool ? "on" : ""}" data-tool="${t.id}">${t.label}</button>`).join("")}</div>`}
        <div class="pe-row">
          <span class="pe-colors">${COLORS.map(c => `<button class="pe-color ${c === (sel ? sel.color : color) ? "on" : ""}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</span>
        </div>
        <div class="pe-chips">${THICKNESS.map(t => `<button class="pe-chip ${t.size === (sel ? sel.size ?? 1 : thickness) ? "on" : ""}" data-thickness="${t.size}">${t.label}</button>`).join("")}</div>
        <div class="pe-row">
          ${sel ? `<button class="pe-text small danger" data-act="deletemark">🗑 Delete this mark</button>` : `
          <button class="pe-text small" data-act="unmark" ${e.marks.length ? "" : "disabled"}>Undo mark</button>
          <button class="pe-text small" data-act="clearmarks" ${e.marks.length ? "" : "disabled"}>Clear all</button>`}
        </div>
        <p class="pe-hint">${sel
          ? "Drag the round handles to resize or re-aim it, drag the mark to move it. Tap empty space to draw another."
          : `Drag on the photo to draw ${tool === "arrow" ? "an arrow (from tail to tip)" : tool === "circle" ? "a circle" : "a box"}. Tap a mark to change it.`}</p>`;
    }
  }

  let sliding = false;
  panel.addEventListener("input", ev => {
    const key = ev.target.dataset.range;
    if (!key) return;
    if (!sliding) { snapshot(); sliding = true; }
    const value = Number(ev.target.value);
    if (key === "brush") { brushSize = value; sliding = false; history.pop(); updateUndo(); }
    else if (key === "straighten") { e.straighten = value; e.crop = null; }
    else if (key === "edge") e.cutout.edge = value;
    else e.adjust[key] = value;
    const label = ev.target.closest(".pe-slider").querySelector("b");
    label.textContent = key === "straighten" ? `${value > 0 ? "+" : ""}${value}°` : key === "edge" && value > 0 ? `+${value}` : String(value);
    redraw();
  });
  panel.addEventListener("change", ev => { if (ev.target.dataset.range) { sliding = false; drawPanel(); } });

  const finish = new Promise(resolve => {
    root.addEventListener("click", async ev => {
      const b = ev.target.closest("button");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (b.dataset.tab) { tab = b.dataset.tab; selected = null; drawPanel(); redraw(); return; }
      if (b.dataset.aspect) { setAspect(b.dataset.aspect); drawPanel(); redraw(); return; }
      if (b.dataset.slider) { slider = b.dataset.slider; drawPanel(); return; }
      if (b.dataset.tool) { tool = b.dataset.tool; drawPanel(); return; }
      if (b.dataset.color) {
        if (selected != null && e.marks[selected]) { snapshot(); e.marks[selected].color = b.dataset.color; redraw(); }
        else color = b.dataset.color;
        drawPanel(); return;
      }
      if (b.dataset.thickness) {
        const size = Number(b.dataset.thickness);
        if (selected != null && e.marks[selected]) { snapshot(); e.marks[selected].size = size; redraw(); }
        else thickness = size;
        drawPanel(); return;
      }
      if (act === "deselect") { select(null); return; }
      if (b.dataset.brush !== undefined) { brush = b.dataset.brush; drawPanel(); return; }
      if (b.dataset.bg) { snapshot(); e.cutout.bg = b.dataset.bg; drawPanel(); redraw(); return; }
      if (act === "highlight") { highlight = !highlight; drawPanel(); redraw(); return; }
      if (act === "removebg") { removeBackground(); return; }
      if (act === "brushundo") {
        const last = maskHistory.pop();
        if (last) { mask.getContext("2d").putImageData(last, 0, 0); mask.dataset.version = String(++maskVersion); maskChanged = true; }
        drawPanel(); redraw(); return;
      }
      if (!act) return;
      if (act === "cancel") return resolve(null);
      if (act === "done") {
        b.disabled = true; b.textContent = "Saving…";
        const { canvas: out } = render(img, e, OUTPUT_SIDE, { mask });
        const blob = await new Promise(r => out.toBlob(r, "image/jpeg", 0.88));
        const newMask = e.cutout && mask && maskChanged ? await new Promise(r => mask.toBlob(r, "image/png")) : null;
        return resolve({ blob, w: out.width, h: out.height, edits: e, maskBlob: newMask });
      }
      if (act === "undo") { if (history.length) e = history.pop(); if (selected != null && !e.marks[selected]) selected = null; updateUndo(); drawPanel(); redraw(); return; }
      snapshot();
      if (act === "rotl" || act === "rotr") { e.rotate = (e.rotate + (act === "rotr" ? 90 : 270)) % 360; e.crop = null; aspect = "free"; }
      else if (act === "flip") { e.flip = !e.flip; e.crop = null; }
      else if (act === "resetcrop") { e.rotate = 0; e.flip = false; e.straighten = 0; e.crop = null; aspect = "free"; }
      else if (act === "auto") e.adjust = autoAdjust(img, e, mask);
      else if (act === "keepbg") { e.cutout = null; brush = ""; highlight = false; }
      else if (act === "reusebg") e.cutout = { bg: "#FFFFFF", edge: 0 };
      else if (act === "resetadjust") e.adjust = { ...NEUTRAL_ADJUST };
      else if (act === "unmark") e.marks.pop();
      else if (act === "clearmarks") { e.marks = []; selected = null; }
      else if (act === "deletemark") { e.marks.splice(selected, 1); selected = null; }
      drawPanel(); redraw();
    });
  });

  const busyBox = root.querySelector(".pe-busy");
  const showBusy = (message, progress) => {
    busyBox.hidden = !message;
    if (!message) return;
    busyBox.querySelector("p").textContent = message;
    busyBox.querySelector(".pe-bar").hidden = progress == null;
    busyBox.querySelector(".pe-bar i").style.width = `${Math.round((progress ?? 0) * 100)}%`;
  };

  async function removeBackground() {
    const where = await backend();
    if (!(await modelDownloaded())) {
      const ok = confirm(`Background removal needs a one-time download of the AI model (about ${where.sizeMB} MB). Use Wi-Fi if you can.\n\nDownload now?`);
      if (!ok) return;
    }
    working = true; drawPanel();
    showBusy("Getting the AI model ready…", null);
    try {
      const found = await findSubject(img, status => {
        if (status.download != null) showBusy(`Downloading the AI model (once only)… ${Math.round(status.download * 100)}%`, status.download);
        else showBusy(`${status.message}${where.gpu ? "" : " This phone has no GPU support in the browser, so this can take a minute."}`, null);
      });
      snapshot();
      maskHistory.length = 0;
      mask = found;
      mask.dataset.version = String(++maskVersion);
      maskChanged = true;
      e.cutout = { bg: "#FFFFFF", edge: 0 };
    } catch (error) {
      alert(`The background could not be removed: ${error.message}`);
    } finally {
      working = false;
      showBusy(null);
      drawPanel(); redraw();
    }
  }

  const onResize = () => redraw();
  window.addEventListener("resize", onResize);
  updateUndo();
  drawPanel();
  requestAnimationFrame(paint);

  const result = await finish;
  window.removeEventListener("resize", onResize);
  document.body.classList.remove("pe-open");
  root.remove();
  return result;
}
