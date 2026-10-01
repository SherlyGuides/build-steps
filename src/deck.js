import PptxGenJS from "pptxgenjs";
import { getImage } from "./db.js";
import { loadParts } from "./library.js";

// =============================================================================
// SLIDE LAYOUT — same 1280 × 720 design-pixel system and colours as Lesson Foundry (app.py).
// A parts list (build.kind === "bom") is just the Materials Required slides.
// Deck: 1 cover (build name, grade, session) → 2 Materials Required (3 rows × 4 columns of part
// cards; a 13th part continues on another slide) → the build steps from slide 3 → Thank You.
// A step slide: "Step N" on the red bar, the instruction highlighted in yellow below it,
// the part(s) used on the left and the photo of the step on the right.
// =============================================================================

const FONT_NAME = "Myriad";
const RUST_COLOR = "C43A12";
const TEXT_COLOR = "111111";
const SUBTITLE_COLOR = "4B4B4B";
const HIGHLIGHT_COLOR = "FFFF00";

export const LAYOUT = {
  cover: {
    title: { x: 101, y: 270, w: 530, h: 100, size: 36 },
    subtitle: { x: 117, y: 340, w: 520, h: 200, size: 28 },
  },
  heading: { x: 40, y: 20, w: 1060, h: 52, size: 32 },
  instruction: { x: 60, y: 92, w: 1160, h: 78, size: 24, minSize: 16 },   // two lines at 24 pt fit above the pictures
  // Step slide: part(s) on the left, step photo on the right. The split is set per step,
  // from 10% – 90% (small part, big photo) to 90% – 10%; see stepAreas().
  content: { x: 50, right: 1220, gap: 40 },
  parts: { x: 50, y: 190, w: 450, h: 440 },
  photo: { x: 540, y: 170, w: 680, h: 470 },
  split: { min: 0.1, max: 0.9, default: 0.2 },
  // "One picture" steps: only the step photo, centred in the whole area under the instruction.
  single: { x: 50, y: 170, w: 1170, h: 470 },
  // "Use previous image" steps: previous photo (left) and this step's photo (right); their own
  // split (step.beforeSplit) from 10% – 90% to 90% – 10%, equal by default. See stepAreas().
  move: { y: 175, h: 465, defaultSplit: 0.5 },
  // Label beside each part picture: "Plate 2 x 2 - 2" (name grey, count bold rust), just the
  // name for a single piece; up to two lines. Per step: the size, and names can be turned off
  // (then only "x 2" is shown, and nothing for a single piece).
  partName: { sizes: [14, 18, 20, 24], default: 18, minSize: 10 },
  slideNumber: { x: 1190, y: 645, w: 50, h: 24, size: 10 },
  thankYou: { text: "Thank You!", x: 40, y: 400, w: 440, h: 110, size: 48 },
  // Materials slide: each part in its own outlined white card, picture centred with a soft shadow under
  // it, part name below, and a light orange "x 3" label in the card's top-right corner.
  bom: {
    heading: "Materials Required",
    // Page behind the cards (build.bomStyle.tint); tinted copies of bg2 below the red bar.
    tints: [
      { id: "white", label: "White", background: "bg2", swatch: "#FFFFFF" },
      { id: "cream", label: "Cream", background: "bg2-cream", swatch: "#FDF6EC" },
      { id: "sand", label: "Sand", background: "bg2-sand", swatch: "#F8ECDC" },
      { id: "peach", label: "Peach", background: "bg2-peach", swatch: "#FCEADC" },
    ],
    // "Show every piece" (build.bomStyle.pieces): the part drawn once per piece, up to maxCopies;
    // a part needed more often than that is shown once.
    maxCopies: 6, copyGap: 0.06,
    area: { x: 70, y: 98, w: 1140, h: 544 },
    cols: 4, rows: 3, gap: 16,   // the default grid; each build can choose another (build.bomGrid)
    cardRadius: 0.08, cardBorder: "C9B8A3", cardLine: 1.25,
    picturePad: { side: 30, top: 26, bottom: 10 },
    name: { h: 40, size: 12, minSize: 9, pad: 8 },       // up to two lines
    count: { h: 32, pad: 11, inset: 8, size: 14, color: "F0965F" },
    // Soft oval under the part: width and height relative to the part's visible width; room below
    // the picture for it (extra), relative to the picture's width.
    shadow: { width: 0.9, height: 0.18, alpha: 0.3, extra: 0.06 },
  },
};

// =============================================================================
// BILL OF MATERIALS
// Worked out from the steps: every part picked in a step, quantities added up, in the order
// the parts are first used. build.bom holds only the user's changes on top of that:
//   overrides: { [partId]: { qty?: number, hidden?: true } }   extras: [{ id, qty }]
// so the list keeps updating by itself as steps change.
// build.partNames: { [partId]: name } renames a part in this build only (Materials and step slides).
// =============================================================================

/** The part as this build names it: the user's name if they renamed it, else the library name. */
export function namedPart(build, part) {
  const custom = part && build?.partNames?.[part.id]?.trim();
  return part && { ...part, name: custom || part.name, libraryName: part.name };
}

export function bomEdits(build) {
  return { overrides: build.bom?.overrides ?? {}, extras: build.bom?.extras ?? [] };
}

/** Every BOM row, including hidden ones, for the review screen. */
export function materials(build, library) {
  const { overrides, extras } = bomEdits(build);
  const auto = new Map();
  for (const step of build.steps) {
    if (MOVES[step.move]) continue;
    for (const p of step.parts) auto.set(p.id, (auto.get(p.id) ?? 0) + p.qty);
  }
  const rows = [...auto].map(([id, qty]) => ({ id, auto: qty, extra: false }));
  for (const e of extras) if (!auto.has(e.id)) rows.push({ id: e.id, auto: 0, extra: true, extraQty: e.qty });
  return rows.map(row => {
    const edit = overrides[row.id] ?? {};
    const base = row.extra ? row.extraQty : row.auto;
    const qty = edit.qty ?? base;
    return { id: row.id, part: namedPart(build, library.get(row.id)), auto: row.auto, qty, edited: !row.extra && edit.qty != null && edit.qty !== row.auto, hidden: !!edit.hidden, extra: row.extra };
  }).filter(row => row.part);
}

/** The rows printed on the Materials Required slides. */
export function bomRows(build, library) {
  return materials(build, library).filter(row => !row.hidden && row.qty > 0);
}

/** Grid choices for the Materials slides, columns × rows. */
export const BOM_GRIDS = [[2, 2], [3, 2], [3, 3], [4, 3], [5, 3], [5, 4], [6, 4]].map(([cols, rows]) => ({ cols, rows }));

/** The build's Materials grid, 4 × 3 unless another one was chosen. */
export function bomGrid(build) {
  const chosen = BOM_GRIDS.find(g => g.cols === build?.bomGrid?.cols && g.rows === build?.bomGrid?.rows);
  return chosen ?? { cols: LAYOUT.bom.cols, rows: LAYOUT.bom.rows };
}

/** Materials slide look for a build: page tint and whether every piece is drawn. */
export function bomStyle(build) {
  const tint = LAYOUT.bom.tints.find(t => t.id === build?.bomStyle?.tint) ?? LAYOUT.bom.tints[0];
  return { tint, pieces: !!build?.bomStyle?.pieces };
}

export function bomPages(rows, grid = bomGrid(null)) {
  const per = grid.cols * grid.rows;
  const pages = [];
  for (let i = 0; i < rows.length; i += per) pages.push(rows.slice(i, i + per));
  return pages;
}

export function bomHeading(page, pageCount) {
  return pageCount > 1 ? `${LAYOUT.bom.heading} (${page + 1}/${pageCount})` : LAYOUT.bom.heading;
}

/** Card, picture, name and count-label boxes for the i-th part on a Materials slide. */
export function bomCell(i, part, grid = bomGrid(null), qty = 1, pieces = false) {
  const b = LAYOUT.bom, p = b.picturePad, { cols, rows } = grid;
  const gap = cols * rows > 12 ? 12 : b.gap;
  const w = (b.area.w - gap * (cols - 1)) / cols, h = (b.area.h - gap * (rows - 1)) / rows;
  // Padding, name, count label and text scale with the card, relative to the approved 4 × 3 card.
  const baseW = (b.area.w - b.gap * (b.cols - 1)) / b.cols, baseH = (b.area.h - b.gap * (b.rows - 1)) / b.rows;
  const k = Math.min(1.7, Math.max(0.62, Math.min(w / baseW, h / baseH)));
  const card = { x: b.area.x + (i % cols) * (w + gap), y: b.area.y + Math.floor(i / cols) * (h + gap), w, h };
  const namePad = b.name.pad * k, nameH = b.name.h * k;
  const name = { x: card.x + namePad, y: card.y + h - nameH - 4 * k, w: w - 2 * namePad, h: nameH };
  // "x 3" label in the card's top-right corner.
  const c = b.count, label = countLabel(qty);
  const countSize = Math.round(c.size * k * 2) / 2, countH = c.h * k;
  const countW = 2 * c.pad * k + label.length * countSize * 96 / 72 * 0.56;
  const count = { x: card.x + w - c.inset * k - countW, y: card.y + c.inset * k, w: countW, h: countH };
  // Pictures: each box includes room under the part for its shadow (see partInPicture).
  const pw = part.w || 1, ph = part.h || 1, aspect = pw / (ph + b.shadow.extra * pw);
  const copies = pieces && qty > 1 && qty <= b.maxCopies ? qty : 1;
  const side = Math.min(p.side * k, w * 0.14);
  const top = copies > 1 ? count.y + countH + 4 * k - card.y : p.top * k;   // copies stay clear of the label
  const area = { x: card.x + (copies > 1 ? 10 * k : side), y: card.y + top, w: w - 2 * (copies > 1 ? 10 * k : side), h: name.y - p.bottom * k - (card.y + top) };
  return {
    card, name, count, pictures: copyBoxes(area, aspect, copies, b.copyGap),
    nameSize: Math.round(b.name.size * k * 2) / 2, nameMin: Math.max(7, b.name.minSize * Math.min(1, k)),
    countSize,
  };
}

// n equal boxes of the given aspect (w / h), as large as they can be in the area: rows of copies
// packed together, the last row centred, the whole group centred.
function copyBoxes(area, aspect, n, gapShare) {
  if (n <= 1) return [fit(area, aspect, 1)];
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const bw = Math.min(area.w / (cols + (cols - 1) * gapShare), area.h * aspect / (rows + (rows - 1) * gapShare));
    if (!best || bw > best.bw) best = { cols, rows, bw };
  }
  const { cols, rows, bw } = best, bh = bw / aspect, gap = bw * gapShare;
  const top = area.y + (area.h - (rows * bh + (rows - 1) * gap)) / 2;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), inRow = Math.min(cols, n - r * cols);
    const left = area.x + (area.w - (inRow * bw + (inRow - 1) * gap)) / 2;
    return { x: left + (i % cols) * (bw + gap), y: top + r * (bh + gap), w: bw, h: bh };
  });
}

/** The part itself inside a picture box (the rest of the box, below it, is room for the shadow). */
export function partInPicture(box, part) {
  return { ...box, h: box.w * (part.h || 1) / (part.w || 1) };
}

export const countLabel = qty => `x ${qty}`;

const IN = v => v / 96; // design pixels → inches (13.333 × 7.5 in wide layout)

// "Use previous image" steps: no part is added (the model is flipped, turned, or just shown again).
// Their slide shows two photos side by side: the previous step's photo (before) on the left and
// this step's (after) on the right. "flip" and "turn" are older names for the same thing.
export const MOVES = {
  prev: { label: "Use previous image", instruction: "" },
  flip: { label: "Use previous image", instruction: "", legacy: true },
  turn: { label: "Use previous image", instruction: "", legacy: true },
};

export function stepHeading(index) {
  return `Step ${index + 1}`;
}

// Design standards. Builds made before the current standard can switch every step to the current
// defaults (parts 20% / photo 80%, part labels at the default size with names on) in one go.
// Builds made from now on start on the current standard.
export const DESIGN_VERSION = 2;

/** Steps whose layout or label settings differ from the current defaults. */
export function outdatedSteps(build) {
  return (build?.steps ?? []).filter(step => !MOVES[step.move] && (
    (step.split != null && step.split !== LAYOUT.split.default) ||
    (step.partName?.size != null && step.partName.size !== LAYOUT.partName.default) ||
    step.partName?.hideNames));
}

/** Whether to offer the update: an older build with steps that are not on the current defaults. */
export const offerDesignUpdate = build => !isPartsList(build) && (build.designVersion ?? 1) < DESIGN_VERSION && outdatedSteps(build).length > 0;

/** Put every step on the current defaults. Photos, parts, text and chosen layouts stay as they are. */
export function applyDesignStandards(build) {
  for (const step of build.steps) {
    if (MOVES[step.move]) continue;
    delete step.split;
    delete step.partName;
  }
  build.designVersion = DESIGN_VERSION;
}

/** A parts list is a standalone Materials Required deck: no cover, no steps, no Thank You. */
export const isPartsList = build => build?.kind === "bom";

export function deckFileName(build) {
  const name = build.name.replace(/[^A-Za-z0-9 _-]+/g, "-").trim().slice(0, 80) || "Build";
  const where = build.grade && build.session ? `_G${build.grade}_S${build.session}` : "";
  return `${name}${isPartsList(build) ? "_Materials" : ""}${where}_v${build.deckVersion}.pptx`;
}

// PowerPoint only shrinks text to fit once someone edits it, so long text is given a smaller
// size here. Estimate: an average character is about half the font size wide.
export function fittedSize(text, area, size, minimum = 10) {
  const words = String(text).split(/\s+/).filter(Boolean);
  for (let pt = size; pt > minimum; pt -= 1) {
    const px = pt * 96 / 72, perLine = Math.max(1, Math.floor(area.w / (px * 0.52)));
    let lines = 1, used = 0;
    for (const word of words) {
      const add = (used ? 1 : 0) + word.length;
      if (used + add > perLine && used) { lines += 1; used = word.length; } else used += add;
    }
    if (lines * px * 1.2 <= area.h) return pt;
  }
  return minimum;
}

// Largest box with the picture's proportions that fits inside the area, centred.
export function fit(area, w, h) {
  const scale = Math.min(area.w / w, area.h / h);
  const fw = w * scale, fh = h * scale;
  return { x: area.x + (area.w - fw) / 2, y: area.y + (area.h - fh) / 2, w: fw, h: fh };
}

// A step uses up to this many different parts; they are stacked in one column on the left.
export const MAX_STEP_PARTS = 3;

// Columns and rows for the parts on the left: one column of up to 3, each sharing the height.
// (Older steps with more parts fall back to two columns.)
export function partsGrid(count) {
  const cols = count <= MAX_STEP_PARTS ? 1 : count <= 8 ? 2 : 3;
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

/** A step set to "One picture": just the step photo, centred. */
export const isSinglePicture = step => step?.layout === "single";

/** The step's share of the width for the left side, between 10% and 90%. */
export function stepSplit(step) {
  const { min, max } = LAYOUT.split;
  const move = !!MOVES[step?.move];
  const value = Number(move ? step?.beforeSplit : step?.split);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : move ? LAYOUT.move.defaultSplit : LAYOUT.split.default;
}

/** Part area (left) and photo area (right) for a step slide. */
export function stepAreas(step) {
  const { x, right, gap } = LAYOUT.content;
  const width = right - x - gap;
  const partsW = Math.round(width * stepSplit(step));
  if (MOVES[step?.move]) {
    // Previous image on the left, this step's image on the right, same height.
    const { y, h } = LAYOUT.move;
    return { parts: { x, y, w: partsW, h }, photo: { x: x + partsW + gap, y, w: width - partsW, h } };
  }
  return {
    parts: { x, y: LAYOUT.parts.y, w: partsW, h: LAYOUT.parts.h },
    photo: { x: x + partsW + gap, y: LAYOUT.photo.y, w: width - partsW, h: LAYOUT.photo.h },
  };
}

/**
 * Where the step photo goes. On a normal step it fills its area (the right 80% by default) as far
 * as its shape allows and sits against the right margin; other layouts centre it in their area.
 */
// Shape assumed for a step that has no photo yet (a usual phone photo).
export const DEFAULT_PHOTO = { w: 4, h: 3 };

export function photoBox(step, photo) {
  if (isSinglePicture(step)) return fit(LAYOUT.single, photo.w, photo.h);
  const area = stepAreas(step).photo, box = fit(area, photo.w, photo.h);
  if (MOVES[step?.move]) return box;
  return { ...box, x: area.x + area.w - box.w };
}

/** Whether to print part names on this step, and at what size (pt). Old builds had one build-wide switch. */
export function partNameStyle(step) {
  const size = LAYOUT.partName.sizes.includes(step?.partName?.size) ? step.partName.size : LAYOUT.partName.default;
  return { show: !step?.partName?.hideNames, size, below: step?.partName?.labelPos === "below" };
}


/** The label under a part as runs: [{ text, count? }]; empty when there is nothing to show. */
export function partLabel(name, qty, names) {
  const runs = names.show ? [{ text: qty > 1 ? `${name}\u00A0- ` : name }] : [];   // no-break space keeps "- 2" together
  if (qty > 1) runs.push({ text: names.show ? String(qty) : countLabel(qty).replace(" ", "\u00A0"), count: true });
  return runs;
}
export const labelText = runs => runs.map(r => r.text).join("");

export function partCells(count, area = LAYOUT.parts) {
  const { cols, rows } = partsGrid(count);
  const w = area.w / cols, h = area.h / rows, pad = count > 1 ? 10 : 0;
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + (i % cols) * w + pad, y: area.y + Math.floor(i / cols) * h + pad, w: w - 2 * pad, h: h - 2 * pad,
  }));
}

/**
 * Where each part's picture and its label ("Plate 2 x 2 - 2") go. Parts are stacked in one
 * column; each label sits to the right of its picture, vertically centred on it, and may use the
 * free space up to labelLimit (the left edge of the step photo). When that space is too narrow the
 * picture gives up part of the column instead. With "Under the part" chosen for the step (and on
 * older steps with more than 3 parts) the label goes under the picture.
 * parts: [{ part: { w, h, name }, qty }]
 */
export function partLayout(parts, names, area = LAYOUT.parts, labelLimit = area.x + area.w) {
  const cells = partCells(parts.length, area);
  const labels = parts.map(({ part, qty }) => partLabel(part.name, qty, names));
  const labelled = labels.some(l => l.length);
  if (names.below || parts.length > MAX_STEP_PARTS) {
    // Label below: room for two lines of the chosen size (points -> design pixels, 1.2 line height).
    const labelH = labelled ? Math.ceil(names.size * 96 / 72 * 1.2 * (names.show ? 2 : 1)) + 4 : 0;
    return parts.map(({ part }, i) => {
      const cell = cells[i], image = fit({ ...cell, h: cell.h - labelH }, part.w || 1, part.h || 1);
      return { image, label: labels[i], labelBox: labels[i].length ? { x: cell.x, y: image.y + image.h + 2, w: cell.w, h: labelH } : null, align: "center" };
    });
  }
  const gap = 14, minLabelW = 150;
  const outside = labelLimit - (area.x + area.w);               // free space right of the column
  const pictureW = !labelled || outside - gap >= minLabelW ? area.w : Math.max(area.w * 0.45, area.w - (minLabelW - Math.max(0, outside)));
  return parts.map(({ part }, i) => {
    const cell = cells[i];
    const image = fit({ ...cell, w: Math.min(cell.w, pictureW) }, part.w || 1, part.h || 1);
    image.x = cell.x;                                            // against the left margin
    const x = image.x + image.w + gap, lineH = names.size * 96 / 72 * 1.2;
    const h = Math.min(cell.h, Math.max(image.h, 3 * lineH + 4));
    return {
      image, label: labels[i], align: "left",
      labelBox: labels[i].length ? { x, y: image.y + image.h / 2 - h / 2, w: Math.max(40, labelLimit - x), h } : null,
    };
  });
}

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// pptxgenjs wants "image/png;base64,..." without the leading "data:".
const pptxData = dataUrl => dataUrl.replace(/^data:/, "");

const partCache = new Map();
async function partPicture(part) {
  if (!partCache.has(part.file)) {
    const dataUrl = await blobToDataUrl(await (await fetch(part.file)).blob());
    partCache.set(part.file, { dataUrl });
  }
  return partCache.get(part.file);
}

// Library pictures are on white. For the Materials slide each one is redrawn with a soft oval
// shadow under the part (found by scanning for non-white pixels) and room below for it.
const shadowCache = new Map();
async function shadowedPicture(part) {
  if (!shadowCache.has(part.file)) {
    const img = await createImageBitmap(await (await fetch(part.file)).blob());
    const { width: w, height: h } = img, sh = LAYOUT.bom.shadow;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h + Math.round(sh.extra * w);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    let left = w, right = 0, bottom = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
    if (right < left) { left = 0; right = w; bottom = h; }
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const rx = (right - left) * sh.width / 2, ry = (right - left) * sh.height / 2;
    ctx.save();
    ctx.translate((left + right) / 2, bottom);
    ctx.scale(1, ry / rx);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    glow.addColorStop(0, `rgba(70, 50, 30, ${sh.alpha})`);
    glow.addColorStop(0.55, `rgba(70, 50, 30, ${sh.alpha * 0.45})`);
    glow.addColorStop(1, "rgba(70, 50, 30, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(-rx, -rx, 2 * rx, 2 * rx);
    ctx.restore();
    ctx.globalCompositeOperation = "multiply";   // the white around the part lets the shadow through
    ctx.drawImage(img, 0, 0);
    shadowCache.set(part.file, { dataUrl: canvas.toDataURL("image/png"), canvas });
  }
  return shadowCache.get(part.file);
}

// "Show every piece": all copies of a part drawn into one picture, so the file holds one image
// per card instead of one per piece. Drawn at 3 pixels per design pixel (about 290 dpi).
async function copiesPicture(part, boxes) {
  const { canvas: one } = await shadowedPicture(part);
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  const box = { x: x0, y: y0, w: Math.max(...boxes.map(b => b.x + b.w)) - x0, h: Math.max(...boxes.map(b => b.y + b.h)) - y0 };
  const k = 3, canvas = document.createElement("canvas");
  canvas.width = Math.round(box.w * k); canvas.height = Math.round(box.h * k);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  for (const b of boxes) ctx.drawImage(one, (b.x - x0) * k, (b.y - y0) * k, b.w * k, b.h * k);
  return { dataUrl: canvas.toDataURL("image/png"), box };
}

async function background(name) {
  return pptxData(await blobToDataUrl(await (await fetch(`slides/${name}.jpg`)).blob()));
}

function text(slide, value, box, options) {
  slide.addText(value, {
    x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), fontFace: FONT_NAME, margin: 0, fit: "shrink", ...options,
  });
}

/** Build the .pptx for a build. Returns a Blob. onProgress(done, total) is called per step. */
export async function buildDeck(build, onProgress = () => {}) {
  const library = await loadParts(build.kit);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = build.name;
  pptx.company = "ThinkPro Academy";

  const partsOnly = isPartsList(build);
  if (!partsOnly) {
    const cover = pptx.addSlide();
    cover.background = { data: await background("bg1") };
    text(cover, build.name, LAYOUT.cover.title, { fontSize: LAYOUT.cover.title.size, color: RUST_COLOR, bold: true, align: "center", valign: "middle" });
    text(cover, `Grade ${build.grade} · Session ${build.session}`, LAYOUT.cover.subtitle, { fontSize: LAYOUT.cover.subtitle.size, color: SUBTITLE_COLOR, align: "center", valign: "middle" });
  }

  const stepBackground = await background("bg2");
  const slideNumber = { x: IN(LAYOUT.slideNumber.x), y: IN(LAYOUT.slideNumber.y), w: IN(LAYOUT.slideNumber.w), h: IN(LAYOUT.slideNumber.h), fontFace: FONT_NAME, fontSize: LAYOUT.slideNumber.size, color: TEXT_COLOR, align: "right" };

  const grid = bomGrid(build);
  const pages = bomPages(bomRows(build, library), grid);
  if (partsOnly && !pages.length) throw new Error("Choose at least one part first.");
  const look = bomStyle(build);
  const bomBackground = pages.length ? await background(look.tint.background) : null;
  for (const [page, rows] of pages.entries()) {
    const slide = pptx.addSlide();
    slide.background = { data: bomBackground };
    slide.slideNumber = slideNumber;
    text(slide, bomHeading(page, pages.length), LAYOUT.heading, { fontSize: LAYOUT.heading.size, color: "FFFFFF", bold: true, valign: "middle" });
    for (const [i, { part, qty }] of rows.entries()) {
      const cell = bomCell(i, part, grid, qty, look.pieces);
      const picture = cell.pictures.length > 1 ? await copiesPicture(part, cell.pictures) : { ...await shadowedPicture(part), box: cell.pictures[0] };
      const b = LAYOUT.bom;
      slide.addShape(pptx.ShapeType.roundRect, { x: IN(cell.card.x), y: IN(cell.card.y), w: IN(cell.card.w), h: IN(cell.card.h), rectRadius: b.cardRadius, fill: { color: "FFFFFF" }, line: { color: b.cardBorder, width: b.cardLine } });
      const { box } = picture;
      slide.addImage({ data: pptxData(picture.dataUrl), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: cell.pictures.length > 1 ? `${cell.pictures.length} × ${part.name}` : part.name });
      text(slide, part.name, cell.name, { fontSize: fittedSize(part.name, cell.name, cell.nameSize, cell.nameMin), color: TEXT_COLOR, align: "center", valign: "middle" });
      slide.addText(countLabel(qty), {
        shape: pptx.ShapeType.roundRect, rectRadius: IN(cell.count.h) / 2, x: IN(cell.count.x), y: IN(cell.count.y), w: IN(cell.count.w), h: IN(cell.count.h),
        fill: { color: b.count.color }, line: { type: "none" },
        fontFace: FONT_NAME, fontSize: cell.countSize, bold: true, color: "FFFFFF", align: "center", valign: "middle", margin: 0,
      });
    }
  }
  for (const [index, step] of (partsOnly ? [] : build.steps).entries()) {
    const slide = pptx.addSlide();
    slide.background = { data: stepBackground };
    slide.slideNumber = slideNumber;
    text(slide, stepHeading(index), LAYOUT.heading, { fontSize: LAYOUT.heading.size, color: "FFFFFF", bold: true, valign: "middle" });
    if (step.instruction.trim()) {
      text(slide, [{ text: step.instruction.trim(), options: { highlight: HIGHLIGHT_COLOR } }], LAYOUT.instruction, { fontSize: fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, LAYOUT.instruction.minSize), color: TEXT_COLOR, valign: "top" });
    }

    const move = MOVES[step.move];
    const areas = stepAreas(step);
    // A custom left picture replaces the part pictures (or, on a "Use previous image" step, the previous photo).
    const single = isSinglePicture(step);
    const left = single ? null : step.leftPhoto;
    if (left) {
      const blob = await getImage(left.id);
      if (blob) {
        const box = fit(areas.parts, left.w, left.h);
        slide.addImage({ data: pptxData(await blobToDataUrl(blob)), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: `${stepHeading(index)}: picture` });
      }
    }
    const before = move && !left && !single ? build.steps[index - 1]?.photo : null;
    if (before) {
      const blob = await getImage(before.id);
      if (blob) {
        const box = fit(areas.parts, before.w, before.h);
        slide.addImage({ data: pptxData(await blobToDataUrl(blob)), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: `Before: ${stepHeading(index - 1)}` });
      }
    }
    // A part picture edited for this step (p.pic) replaces the library picture on this slide only.
    const parts = MOVES[step.move] || left || single ? [] : step.parts.map(p => {
      const part = namedPart(build, library.get(p.id));
      return part && { ...p, part: p.pic ? { ...part, w: p.pic.w, h: p.pic.h } : part };
    }).filter(Boolean);
    const names = partNameStyle(step, build);
    const placed = partLayout(parts, names, areas.parts, photoBox(step, step.photo ?? DEFAULT_PHOTO).x - 24);
    for (const [i, { part, qty, pic }] of parts.entries()) {
      const { image, label, labelBox, align } = placed[i];
      const edited = pic && await getImage(pic.id);
      const picture = edited ? { dataUrl: await blobToDataUrl(edited) } : await partPicture(part);
      slide.addImage({ data: pptxData(picture.dataUrl), x: IN(image.x), y: IN(image.y), w: IN(image.w), h: IN(image.h), altText: part.name });
      if (labelBox) text(slide, label.map(r => r.count ? { text: r.text, options: { bold: true, color: RUST_COLOR } } : { text: r.text }), labelBox, { fontSize: fittedSize(labelText(label), labelBox, names.size, LAYOUT.partName.minSize), color: SUBTITLE_COLOR, align, valign: align === "left" ? "middle" : "top" });
    }

    if (step.photo) {
      const blob = await getImage(step.photo.id);
      if (blob) {
        const box = photoBox(step, step.photo);
        slide.addImage({ data: pptxData(await blobToDataUrl(blob)), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: stepHeading(index) });
      }
    }
    onProgress(index + 1, build.steps.length);
  }

  if (!partsOnly) {
    const closing = pptx.addSlide();
    closing.background = { data: await background("bg3") };
    const t = LAYOUT.thankYou;
    text(closing, t.text, t, { fontSize: t.size, color: RUST_COLOR, bold: true, align: "center", valign: "middle" });
  }
  return pptx.write({ outputType: "blob", compression: true });
}
