import PptxGenJS from "pptxgenjs";
import { getImage } from "./db.js";
import { loadParts } from "./library.js";

// =============================================================================
// SLIDE LAYOUT — same 1280 × 720 design-pixel system and colours as Lesson Foundry (app.py).
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
  instruction: { x: 60, y: 100, w: 1160, h: 64, size: 20 },
  // Step slide: part(s) on the left, step photo on the right. The split is set per step,
  // from ¼ – ¾ (small part, big photo) to ½ – ½; see stepAreas().
  content: { x: 50, right: 1220, gap: 40 },
  parts: { x: 50, y: 190, w: 450, h: 440 },
  photo: { x: 540, y: 170, w: 680, h: 470 },
  split: { min: 0.25, max: 0.5, default: 0.4 },
  // Flip / turn steps: before (previous step's photo) and after, the same size.
  moveBefore: { x: 50, y: 175, w: 570, h: 465 },
  moveAfter: { x: 650, y: 175, w: 570, h: 465 },
  // Part name under the part picture: off unless turned on for the step; up to two lines.
  partName: { sizes: [16, 20, 24, 28], default: 24, minSize: 12 },
  quantity: { size: 24 },
  slideNumber: { x: 1190, y: 645, w: 50, h: 24, size: 10 },
  thankYou: { text: "Thank You!", x: 40, y: 400, w: 440, h: 110, size: 48 },
  // Materials slide ("Clean cards"): white cards, picture centred, part name below it,
  // a rust count circle with a white ring on the picture's top-right corner.
  bom: {
    heading: "Materials Required",
    area: { x: 70, y: 98, w: 1140, h: 544 },
    cols: 4, rows: 3, gap: 16,
    cardRadius: 0.08, cardBorder: "E6DDCF",
    picturePad: { side: 34, top: 14, bottom: 8 },
    name: { h: 40, size: 12, minSize: 9, pad: 8 },       // up to two lines
    badge: { d: 36, ring: 2, size: 14 },
  },
};

// =============================================================================
// BILL OF MATERIALS
// Worked out from the steps: every part picked in a step, quantities added up, in the order
// the parts are first used. build.bom holds only the user's changes on top of that:
//   overrides: { [partId]: { qty?: number, hidden?: true } }   extras: [{ id, qty }]
// so the list keeps updating by itself as steps change.
// =============================================================================

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
    return { id: row.id, part: library.get(row.id), auto: row.auto, qty, edited: !row.extra && edit.qty != null && edit.qty !== row.auto, hidden: !!edit.hidden, extra: row.extra };
  }).filter(row => row.part);
}

/** The rows printed on the Materials Required slides. */
export function bomRows(build, library) {
  return materials(build, library).filter(row => !row.hidden && row.qty > 0);
}

export function bomPages(rows) {
  const per = LAYOUT.bom.cols * LAYOUT.bom.rows;
  const pages = [];
  for (let i = 0; i < rows.length; i += per) pages.push(rows.slice(i, i + per));
  return pages;
}

export function bomHeading(page, pageCount) {
  return pageCount > 1 ? `${LAYOUT.bom.heading} (${page + 1}/${pageCount})` : LAYOUT.bom.heading;
}

/** Card, picture, name and count-circle boxes for the i-th part on a Materials slide. */
export function bomCell(i, part) {
  const b = LAYOUT.bom, p = b.picturePad;
  const w = (b.area.w - b.gap * (b.cols - 1)) / b.cols, h = (b.area.h - b.gap * (b.rows - 1)) / b.rows;
  const card = { x: b.area.x + (i % b.cols) * (w + b.gap), y: b.area.y + Math.floor(i / b.cols) * (h + b.gap), w, h };
  const name = { x: card.x + b.name.pad, y: card.y + h - b.name.h - 4, w: w - 2 * b.name.pad, h: b.name.h };
  const picture = fit({ x: card.x + p.side, y: card.y + p.top, w: w - 2 * p.side, h: name.y - p.bottom - (card.y + p.top) }, part.w || 1, part.h || 1);
  // Circle centred on the picture's top-right corner, kept inside the card.
  const r = b.badge.d / 2;
  const cx = Math.min(picture.x + picture.w + 4, card.x + w - r - 6), cy = Math.max(picture.y + 6, card.y + r + 6);
  return { card, picture, name, badge: { x: cx - r, y: cy - r, w: b.badge.d, h: b.badge.d } };
}

const IN = v => v / 96; // design pixels → inches (13.333 × 7.5 in wide layout)

// Steps where no part is added: the assembly is flipped or turned. Their slide shows two photos
// side by side: the previous step's photo (before) on the left and this step's (after) on the right.
export const MOVES = {
  flip: { label: "Flip over", instruction: "Flip the assembly upside down" },
  turn: { label: "Turn around", instruction: "Turn the assembly around" },
};

export function stepHeading(index) {
  return `Step ${index + 1}`;
}

export function deckFileName(build) {
  const name = build.name.replace(/[^A-Za-z0-9 _-]+/g, "-").trim().slice(0, 80) || "Build";
  return `${name}_G${build.grade}_S${build.session}_v${build.deckVersion}.pptx`;
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

// Columns and rows for the parts on the left: 1 part fills the area, more share it.
export function partsGrid(count) {
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  return { cols, rows: Math.ceil(count / cols) };
}

/** The step's share of the width for the part(s), between ¼ and ½. */
export function stepSplit(step) {
  const { min, max } = LAYOUT.split;
  const value = Number(step?.split);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : LAYOUT.split.default;
}

/** Part area (left) and photo area (right) for a step slide. */
export function stepAreas(step) {
  const { x, right, gap } = LAYOUT.content;
  const width = right - x - gap;
  const partsW = Math.round(width * stepSplit(step));
  return {
    parts: { x, y: LAYOUT.parts.y, w: partsW, h: LAYOUT.parts.h },
    photo: { x: x + partsW + gap, y: LAYOUT.photo.y, w: width - partsW, h: LAYOUT.photo.h },
  };
}

/** Whether to print part names on this step, and at what size (pt). Old builds had one build-wide switch. */
export function partNameStyle(step, build) {
  const show = step?.partName ? !!step.partName.show : !!build?.showPartNames;
  const size = LAYOUT.partName.sizes.includes(step?.partName?.size) ? step.partName.size : LAYOUT.partName.default;
  return { show, size };
}

export function partCells(count, area = LAYOUT.parts) {
  const { cols, rows } = partsGrid(count);
  const w = area.w / cols, h = area.h / rows, pad = count > 1 ? 10 : 0;
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + (i % cols) * w + pad, y: area.y + Math.floor(i / cols) * h + pad, w: w - 2 * pad, h: h - 2 * pad,
  }));
}

const QTY_H = 38;

/**
 * Where each part's picture, quantity ("x2") and optional name go. The labels sit directly under
 * the picture, so they stay with it however wide or tall the picture is.
 * parts: [{ part: { w, h, name }, qty }]
 */
export function partLayout(parts, names, area = LAYOUT.parts) {
  const cells = partCells(parts.length, area);
  // Room for two lines of the chosen size (points -> design pixels, 1.2 line height).
  const nameH = names.show ? Math.ceil(names.size * 96 / 72 * 1.2 * 2) + 4 : 0;
  return parts.map(({ part, qty }, i) => {
    const cell = cells[i];
    const below = (qty > 1 ? QTY_H : 0) + nameH;
    const image = fit({ ...cell, h: cell.h - below }, part.w || 1, part.h || 1);
    let y = image.y + image.h;
    const qtyBox = qty > 1 ? { x: cell.x, y, w: cell.w, h: QTY_H } : null;
    if (qtyBox) y += QTY_H;
    const nameBox = names.show ? { x: cell.x, y, w: cell.w, h: nameH } : null;
    return { image, qtyBox, nameBox };
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

  const cover = pptx.addSlide();
  cover.background = { data: await background("bg1") };
  text(cover, build.name, LAYOUT.cover.title, { fontSize: LAYOUT.cover.title.size, color: RUST_COLOR, bold: true, align: "center", valign: "middle" });
  text(cover, `Grade ${build.grade} · Session ${build.session}`, LAYOUT.cover.subtitle, { fontSize: LAYOUT.cover.subtitle.size, color: SUBTITLE_COLOR, align: "center", valign: "middle" });

  const stepBackground = await background("bg2");
  const slideNumber = { x: IN(LAYOUT.slideNumber.x), y: IN(LAYOUT.slideNumber.y), w: IN(LAYOUT.slideNumber.w), h: IN(LAYOUT.slideNumber.h), fontFace: FONT_NAME, fontSize: LAYOUT.slideNumber.size, color: TEXT_COLOR, align: "right" };

  const pages = bomPages(bomRows(build, library));
  for (const [page, rows] of pages.entries()) {
    const slide = pptx.addSlide();
    slide.background = { data: stepBackground };
    slide.slideNumber = slideNumber;
    text(slide, bomHeading(page, pages.length), LAYOUT.heading, { fontSize: LAYOUT.heading.size, color: "FFFFFF", bold: true, valign: "middle" });
    for (const [i, { part, qty }] of rows.entries()) {
      const cell = bomCell(i, part);
      const picture = await partPicture(part);
      const b = LAYOUT.bom;
      slide.addShape(pptx.ShapeType.roundRect, { x: IN(cell.card.x), y: IN(cell.card.y), w: IN(cell.card.w), h: IN(cell.card.h), rectRadius: b.cardRadius, fill: { color: "FFFFFF" }, line: { color: b.cardBorder, width: 0.75 } });
      slide.addImage({ data: pptxData(picture.dataUrl), x: IN(cell.picture.x), y: IN(cell.picture.y), w: IN(cell.picture.w), h: IN(cell.picture.h), altText: part.name });
      text(slide, part.name, cell.name, { fontSize: fittedSize(part.name, cell.name, b.name.size, b.name.minSize), color: TEXT_COLOR, align: "center", valign: "middle" });
      slide.addText(String(qty), {
        shape: pptx.ShapeType.ellipse, x: IN(cell.badge.x), y: IN(cell.badge.y), w: IN(cell.badge.w), h: IN(cell.badge.h),
        fill: { color: RUST_COLOR }, line: { color: "FFFFFF", width: b.badge.ring },
        fontFace: FONT_NAME, fontSize: qty > 99 ? b.badge.size - 3 : b.badge.size, bold: true, color: "FFFFFF", align: "center", valign: "middle", margin: 0,
      });
    }
  }
  for (const [index, step] of build.steps.entries()) {
    const slide = pptx.addSlide();
    slide.background = { data: stepBackground };
    slide.slideNumber = slideNumber;
    text(slide, stepHeading(index), LAYOUT.heading, { fontSize: LAYOUT.heading.size, color: "FFFFFF", bold: true, valign: "middle" });
    if (step.instruction.trim()) {
      text(slide, [{ text: step.instruction.trim(), options: { highlight: HIGHLIGHT_COLOR } }], LAYOUT.instruction, { fontSize: fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, 14), color: TEXT_COLOR, valign: "top" });
    }

    const move = MOVES[step.move];
    const before = move ? build.steps[index - 1]?.photo : null;
    if (before) {
      const blob = await getImage(before.id);
      if (blob) {
        const box = fit(LAYOUT.moveBefore, before.w, before.h);
        slide.addImage({ data: pptxData(await blobToDataUrl(blob)), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: `Before: ${stepHeading(index - 1)}` });
      }
    }
    const parts = MOVES[step.move] ? [] : step.parts.map(p => ({ ...p, part: library.get(p.id) })).filter(p => p.part);
    const areas = stepAreas(step), names = partNameStyle(step, build);
    const placed = partLayout(parts, names, areas.parts);
    for (const [i, { part, qty }] of parts.entries()) {
      const { image, qtyBox, nameBox } = placed[i];
      const picture = await partPicture(part);
      slide.addImage({ data: pptxData(picture.dataUrl), x: IN(image.x), y: IN(image.y), w: IN(image.w), h: IN(image.h), altText: part.name });
      if (qtyBox) text(slide, `x${qty}`, qtyBox, { fontSize: LAYOUT.quantity.size, color: RUST_COLOR, bold: true, align: "center", valign: "middle" });
      if (nameBox) text(slide, part.name, nameBox, { fontSize: fittedSize(part.name, nameBox, names.size, LAYOUT.partName.minSize), color: SUBTITLE_COLOR, align: "center", valign: "top" });
    }

    if (step.photo) {
      const blob = await getImage(step.photo.id);
      if (blob) {
        const box = fit(move ? LAYOUT.moveAfter : areas.photo, step.photo.w, step.photo.h);
        slide.addImage({ data: pptxData(await blobToDataUrl(blob)), x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), altText: stepHeading(index) });
      }
    }
    onProgress(index + 1, build.steps.length);
  }

  const closing = pptx.addSlide();
  closing.background = { data: await background("bg3") };
  const t = LAYOUT.thankYou;
  text(closing, t.text, t, { fontSize: t.size, color: RUST_COLOR, bold: true, align: "center", valign: "middle" });
  return pptx.write({ outputType: "blob", compression: true });
}
