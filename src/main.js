import { deleteBuild, deleteImage, getBuild, getImage, keepStorage, listBuilds, putImage, saveBuild, uid } from "./db.js";
import { LAYOUT, MOVES, bomCell, fittedSize, bomHeading, bomPages, bomRows, buildDeck, deckFileName, fit, materials, moveIconBox, partLayout, stepHeading } from "./deck.js";
import { pickBuildFile, pickGalleryPhotos, preparePhoto, saveAndShare, takePhoto } from "./device.js";
import { kitName, loadKits, loadParts } from "./library.js";
import { buildFileName, exportBuild, importBuild } from "./transfer.js";

// Screens, chosen by the address so the phone's Back button works:
//   #/                          builds on this phone
//   #/build/<id>                the steps of one build
//   #/build/<id>/step/<stepId>  edit one step (#…/parts opens the part picker on top)

const MIN_GRADE = 1, MAX_GRADE = 9, MIN_SESSION = 1, MAX_SESSION = 30;
const MAX_NAME = 80, MAX_INSTRUCTION = 200, LONG_INSTRUCTION = 110;

const app = document.getElementById("app");
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = selector => app.querySelector(selector);

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function fail(error) {
  console.error(error);
  toast(error?.message || "Something went wrong.");
}

// Object URLs for stored photos, created once per photo.
const photoUrls = new Map();
async function photoUrl(photo) {
  if (!photo) return "";
  if (!photoUrls.has(photo.id)) {
    const blob = await getImage(photo.id);
    photoUrls.set(photo.id, blob ? URL.createObjectURL(blob) : "");
  }
  return photoUrls.get(photo.id);
}
function forgetPhoto(id) {
  const url = photoUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  photoUrls.delete(id);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function dialog(html, setup) {
  return new Promise(resolve => {
    const el = document.createElement("dialog");
    el.innerHTML = html;
    document.body.append(el);
    const close = value => { el.close(); el.remove(); resolve(value); };
    el.addEventListener("cancel", e => { e.preventDefault(); close(null); });
    el.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => close(null)));
    setup?.(el, close);
    el.showModal();
  });
}

function confirmDialog(title, message, action, danger = true) {
  return dialog(`
    <h2>${esc(title)}</h2><p>${esc(message)}</p>
    <div class="dialog-actions"><button class="btn ghost" data-close>Cancel</button>
    <button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(action)}</button></div>`,
  (el, close) => el.querySelector("[data-ok]").addEventListener("click", () => close(true)));
}

async function detailsDialog(build) {
  const kits = await loadKits();
  const range = (min, max, value) => Array.from({ length: max - min + 1 }, (_, i) => min + i)
    .map(n => `<option value="${n}" ${n === value ? "selected" : ""}>${n}</option>`).join("");
  return dialog(`
    <form method="dialog" class="details">
      <h2>${build ? "Build details" : "New build"}</h2>
      <label>Build name<input name="name" required maxlength="${MAX_NAME}" autocomplete="off" placeholder="e.g. Tipper Truck" value="${esc(build?.name)}"></label>
      <div class="row">
        <label>Grade<select name="grade" required>${build ? "" : '<option value="" selected disabled>Choose</option>'}${range(MIN_GRADE, MAX_GRADE, build?.grade)}</select></label>
        <label>Session<select name="session" required>${build ? "" : '<option value="" selected disabled>Choose</option>'}${range(MIN_SESSION, MAX_SESSION, build?.session)}</select></label>
      </div>
      <label>Parts library<select name="kit" ${build?.steps.some(s => s.parts.length) ? "disabled" : ""}>${kits.map(k => `<option value="${esc(k.id)}" ${k.id === (build?.kit ?? kits[0].id) ? "selected" : ""}>${esc(k.name)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="showPartNames" ${build?.showPartNames ? "checked" : ""}> Print part names under the part pictures</label>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancel</button>
      <button class="btn primary">${build ? "Save" : "Start build"}</button></div>
    </form>`,
  (el, close) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const name = form.name.value.replace(/\s+/g, " ").trim();
      if (!name) { form.name.focus(); return; }
      close({ name, grade: Number(form.grade.value), session: Number(form.session.value), kit: form.kit.value || build?.kit, showPartNames: form.showPartNames.checked });
    });
  });
}

// ---------------------------------------------------------------------------
// Home: builds on this phone
// ---------------------------------------------------------------------------

async function renderHome() {
  const builds = await listBuilds();
  const names = Object.fromEntries((await loadKits()).map(k => [k.id, k.name]));
  app.innerHTML = `
    <header class="bar"><div class="brand"><span class="mark"></span><div><h1>Build Steps</h1><p>Build instruction decks</p></div></div></header>
    <section class="page">
      ${builds.length ? `<ul class="build-list">${builds.map(b => `
        <li><a href="#/build/${esc(b.id)}" class="build-card">
          <strong>${esc(b.name)}</strong>
          <span>Grade ${b.grade} · Session ${b.session} · ${esc(names[b.kit] ?? b.kit)}</span>
          <span class="meta">${b.steps.length} step${b.steps.length === 1 ? "" : "s"} · edited ${new Date(b.updatedAt).toLocaleDateString()}</span>
        </a></li>`).join("")}</ul>`
      : `<div class="empty"><h2>No builds yet</h2><p>Start a build, photograph each step, pick the parts it uses and write the instruction. Generate Deck makes the PowerPoint.</p></div>`}
    </section>
    <footer class="actions">
      <button class="btn secondary" id="import">Open build file</button>
      <button class="btn primary" id="new">New build</button>
    </footer>`;
  $("#new").addEventListener("click", async () => {
    const details = await detailsDialog(null);
    if (!details) return;
    const build = { id: uid(), ...details, deckVersion: 1, steps: [], createdAt: Date.now() };
    await saveBuild(build);
    location.hash = `#/build/${build.id}`;
  });
  $("#import").addEventListener("click", async () => {
    const file = await pickBuildFile();
    if (!file) return;
    try {
      const build = await importBuild(file);
      toast(`"${build.name}" opened with ${build.steps.length} steps.`);
      location.hash = `#/build/${build.id}`;
    } catch (error) { fail(error); }
  });
}

// ---------------------------------------------------------------------------
// Build: the list of steps
// ---------------------------------------------------------------------------

function stepIssues(step) {
  return [!step.photo && "no photo", !step.parts.length && !MOVES[step.move] && "no parts", !step.instruction.trim() && "no instruction"].filter(Boolean);
}

async function renderBuild(buildId) {
  const build = await getBuild(buildId);
  if (!build) { location.replace("#/"); return; }
  const library = await loadParts(build.kit);
  const thumbs = await Promise.all(build.steps.map(s => photoUrl(s.photo)));
  const incomplete = build.steps.filter(s => stepIssues(s).length).length;
  const bom = bomRows(build, library);
  const edited = materials(build, library).some(r => r.edited || r.hidden || r.extra);
  const pieces = bom.reduce((sum, r) => sum + r.qty, 0);

  app.innerHTML = `
    <header class="bar">
      <a href="#/" class="icon-btn" aria-label="All builds">‹</a>
      <div class="title"><h1>${esc(build.name)}</h1><p>Grade ${build.grade} · Session ${build.session} · ${esc(await kitName(build.kit))}</p></div>
      <button class="icon-btn" id="menu" aria-label="Build options">⋯</button>
    </header>
    <section class="page">
      <a class="bom-card" href="#/build/${esc(build.id)}/bom">
        <span class="bom-head"><strong>Materials required</strong><span>Slide 2${bomPages(bom).length > 1 ? `–${bomPages(bom).length + 1}` : ""}</span></span>
        ${bom.length ? `<span class="bom-thumbs">${bom.slice(0, 6).map(r => `<span><img src="${esc(r.part.file)}" alt=""><b>${r.qty}</b></span>`).join("")}${bom.length > 6 ? `<em>+${bom.length - 6}</em>` : ""}</span>
        <span class="meta">${bom.length} part${bom.length === 1 ? "" : "s"} · ${pieces} piece${pieces === 1 ? "" : "s"}${edited ? " · edited" : " · worked out from the steps"}</span>`
        : `<span class="meta">Filled in automatically from the parts you choose in each step.</span>`}
        <span class="bom-edit">Review &amp; edit BOM ›</span>
      </a>
      <h2 class="section-title">Build steps <span>from slide ${bomPages(bom).length + 2}</span></h2>
      ${build.steps.length ? `<ol class="step-list">${build.steps.map((step, i) => {
        const issues = stepIssues(step);
        return `<li class="step-card" data-step="${esc(step.id)}">
          <button class="step-open" data-open="${esc(step.id)}">
            <span class="step-no">${i + 1}</span>
            <span class="step-thumb">${thumbs[i] ? `<img src="${thumbs[i]}" alt="">` : "<em>No photo</em>"}</span>
            <span class="step-body">
              <span class="step-text">${esc(step.instruction) || "<em>No instruction yet</em>"}</span>
              <span class="step-parts">${MOVES[step.move] ? `<img src="${MOVES[step.move].icon}" alt=""><i>${MOVES[step.move].label}</i>` : ""}${MOVES[step.move] ? "" : step.parts.map(p => library.get(p.id)).filter(Boolean).slice(0, 4).map(p => `<img src="${esc(p.file)}" alt="${esc(p.name)}">`).join("")}${!MOVES[step.move] && step.parts.length > 4 ? `<b>+${step.parts.length - 4}</b>` : ""}</span>
              ${issues.length ? `<span class="warn">${issues.join(" · ")}</span>` : ""}
            </span>
          </button>
          <span class="step-move">
            <button class="icon-btn small" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move step ${i + 1} up">↑</button>
            <button class="icon-btn small" data-down="${i}" ${i === build.steps.length - 1 ? "disabled" : ""} aria-label="Move step ${i + 1} down">↓</button>
          </span>
        </li>`;
      }).join("")}</ol>`
      : `<div class="empty"><h2>Add the first step</h2><p>Photograph the model after the step, choose the part it uses from the ${esc(await kitName(build.kit))} list and type the instruction exactly as it should appear on the slide.</p></div>`}
      <button class="btn secondary wide gallery-add" id="gallery-add">🖼 Add steps from gallery</button>
      <p class="hint center">Select one or more photos: each becomes a step, in the order you select them.</p>
    </section>
    <footer class="actions">
      <button class="btn secondary" id="add">📷 Add step</button>
      <button class="btn primary" id="generate" ${build.steps.length ? "" : "disabled"}>Generate deck</button>
    </footer>`;

  app.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { location.hash = `#/build/${build.id}/step/${b.dataset.open}`; }));
  const move = async (from, to) => {
    const [step] = build.steps.splice(from, 1);
    build.steps.splice(to, 0, step);
    await saveBuild(build);
    renderBuild(buildId);
  };
  app.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => move(+b.dataset.up, +b.dataset.up - 1)));
  app.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => move(+b.dataset.down, +b.dataset.down + 1)));
  $("#add").addEventListener("click", () => addStep(build, build.steps.length));
  $("#gallery-add").addEventListener("click", () => addStepsFromGallery(build));
  $("#generate").addEventListener("click", () => generate(build, incomplete));
  $("#menu").addEventListener("click", () => buildMenu(build));
}

// Called straight from a tap: the camera opens first (browsers only allow that from a tap),
// then the new step opens with the part list, so each step is photo → part → instruction.
async function addStep(build, at) {
  const shooting = takePhoto("camera").catch(error => { fail(error); return null; });
  const step = { id: uid(), instruction: "", move: null, parts: [], photo: null };
  const shot = await shooting;
  if (shot) {
    step.photo = { id: uid(), w: shot.w, h: shot.h };
    await putImage(step.photo.id, shot.blob);
  }
  const fresh = await getBuild(build.id);
  fresh.steps.splice(at, 0, step);
  await saveBuild(fresh);
  const editor = `#/build/${build.id}/step/${step.id}`;
  // With a photo, go straight to the part list; Back from there returns to the new step.
  if (shot) { history.pushState(null, "", editor); location.hash = `${editor}/parts`; }
  else location.hash = editor;
}

// One new step per selected photo, added at the end. Then the first of them opens with the
// part list; ›› in the step editor moves on to the next.
async function addStepsFromGallery(build) {
  const files = await pickGalleryPhotos();
  if (!files.length) return;
  const steps = [];
  try {
    for (const [i, file] of files.entries()) {
      busy(true, `Adding photo ${i + 1} of ${files.length}…`);
      const shot = await preparePhoto(file);
      const photo = { id: uid(), w: shot.w, h: shot.h };
      await putImage(photo.id, shot.blob);
      steps.push({ id: uid(), instruction: "", move: null, parts: [], photo });
    }
  } catch (error) {
    fail(error);
  } finally {
    busy(false);
  }
  if (!steps.length) return;
  const fresh = await getBuild(build.id);
  const first = fresh.steps.length + 1;
  fresh.steps.push(...steps);
  await saveBuild(fresh);
  toast(steps.length === 1 ? `Step ${first} added.` : `Steps ${first}–${first + steps.length - 1} added. Choose each step's parts and instruction.`);
  const editor = `#/build/${build.id}/step/${steps[0].id}`;
  history.pushState(null, "", editor);
  location.hash = `${editor}/parts`;
}

async function buildMenu(build) {
  const choice = await dialog(`
    <h2>${esc(build.name)}</h2>
    <div class="menu">
      <button class="btn secondary" data-choice="details">Edit name, grade, session</button>
      <button class="btn secondary" data-choice="export">Save build file (backup / another device)</button>
      <button class="btn danger-ghost" data-choice="delete">Delete build</button>
    </div>
    <div class="dialog-actions"><button class="btn ghost" data-close>Close</button></div>`,
  (el, close) => el.querySelectorAll("[data-choice]").forEach(b => b.addEventListener("click", () => close(b.dataset.choice))));

  if (choice === "details") {
    const details = await detailsDialog(build);
    if (!details) return;
    Object.assign(build, details);
    await saveBuild(build);
    renderBuild(build.id);
  } else if (choice === "export") {
    try {
      busy(true, "Packing the build file…");
      const blob = await exportBuild(build);
      busy(false);
      await offerFile(blob, buildFileName(build), build.name, "Build file ready");
    } catch (error) { busy(false); fail(error); }
  } else if (choice === "delete") {
    if (!(await confirmDialog("Delete this build?", `"${build.name}" and its ${build.steps.length} step photos will be removed from this phone. Decks already made are not affected.`, "Delete"))) return;
    build.steps.forEach(s => s.photo && forgetPhoto(s.photo.id));
    await deleteBuild(build);
    location.hash = "#/";
  }
}

// Sharing must start from a tap, and a long deck takes longer than the browser allows after
// the Generate tap, so the finished file waits behind its own button.
async function offerFile(blob, fileName, title, heading) {
  const go = await dialog(`
    <h2>${esc(heading)}</h2><p class="file-name">${esc(fileName)}</p>
    <div class="dialog-actions"><button class="btn ghost" data-close>Close</button>
    <button class="btn primary" data-ok>Save / Share</button></div>`,
  (el, close) => el.querySelector("[data-ok]").addEventListener("click", () => close(true)));
  if (go) toast(await saveAndShare(blob, fileName, title));
}

function busy(on, message = "") {
  let el = document.getElementById("busy");
  if (!on) { el?.remove(); return; }
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "busy" });
    el.innerHTML = `<div class="busy-box"><div class="spinner"></div><p></p></div>`;
    document.body.append(el);
  }
  el.querySelector("p").textContent = message;
}

async function generate(build, incomplete) {
  if (incomplete && !(await confirmDialog("Some steps are not finished",
    `${incomplete} step${incomplete === 1 ? " is" : "s are"} missing a photo, parts or instruction. Make the deck anyway?`, "Make deck", false))) return;
  try {
    busy(true, "Preparing slides…");
    const blob = await buildDeck(build, (done, total) => busy(true, `Building step ${done} of ${total}…`));
    const fileName = deckFileName(build);
    busy(true, "Saving the deck…");
    build.deckVersion += 1;
    await saveBuild(build);
    busy(false);
    await offerFile(blob, fileName, build.name, "Deck ready");
  } catch (error) {
    busy(false);
    fail(error);
  }
}

// ---------------------------------------------------------------------------
// Review & edit BOM
// ---------------------------------------------------------------------------

function bomSlidePreview(rows, page, pageCount) {
  return `<div class="slide" aria-label="Materials slide preview">
    <div class="s-heading" style="${box(LAYOUT.heading)};${fontSize(LAYOUT.heading.size)}">${esc(bomHeading(page, pageCount))}</div>
    ${rows.map(({ part, qty }, i) => {
      const c = bomCell(i, part);
      return `<div class="s-card" style="${box(c.card)}"></div>
        <img class="s-part" src="${esc(part.file)}" style="${box(c.picture)}" alt="">
        <div class="s-bom-name" style="${box(c.name)};${fontSize(fittedSize(part.name, c.name, LAYOUT.bom.name.size))}">${esc(part.name)}</div>
        <div class="s-bom-qty" style="${box(c.qty)};${fontSize(LAYOUT.bom.quantity.size)}">x${qty}</div>`;
    }).join("")}
    ${rows.length ? "" : `<div class="s-photo-empty" style="${box(LAYOUT.bom.area)}">Parts chosen in the steps appear here</div>`}
  </div>`;
}

function setOverride(build, id, change) {
  build.bom = { overrides: { ...build.bom?.overrides }, extras: [...(build.bom?.extras ?? [])] };
  const next = { ...build.bom.overrides[id], ...change };
  for (const key of Object.keys(next)) if (next[key] == null || next[key] === false) delete next[key];
  if (Object.keys(next).length) build.bom.overrides[id] = next; else delete build.bom.overrides[id];
}

function setExtra(build, id, qty) {
  build.bom = { overrides: { ...build.bom?.overrides }, extras: (build.bom?.extras ?? []).filter(e => e.id !== id) };
  if (qty > 0) build.bom.extras.push({ id, qty });
}

async function renderBom(buildId, { picker = false } = {}) {
  const build = await getBuild(buildId);
  if (!build) { location.replace("#/"); return; }
  const library = await loadParts(build.kit);
  const here = `#/build/${buildId}/bom`;

  const draw = () => {
    const rows = materials(build, library);
    const pages = bomPages(rows.filter(r => !r.hidden && r.qty > 0));
    app.innerHTML = `
      <header class="bar">
        <a href="#/build/${esc(buildId)}" class="icon-btn" aria-label="Back to steps">‹</a>
        <div class="title"><h1>Materials required</h1><p>${esc(build.name)} · ${pages.length > 1 ? `slides 2–${pages.length + 1}` : "slide 2"}</p></div>
      </header>
      <section class="page editor">
        <div class="bom-previews">${(pages.length ? pages : [[]]).map((page, i) => bomSlidePreview(page, i, pages.length)).join("")}</div>
        <p class="hint">Quantities are added up from the steps automatically and stay up to date when steps change. Change a number, hide a part or add an extra one here; <b>↺</b> goes back to the automatic count.${pages.length > 1 ? ` More than ${LAYOUT.bom.cols * LAYOUT.bom.rows} parts continue on another Materials slide.` : ""}</p>
        ${rows.length ? `<ul class="chosen bom-rows">${rows.map(r => `
          <li class="${r.hidden ? "hidden-row" : ""}">
            <img src="${esc(r.part.file)}" alt="">
            <span class="name">${esc(r.part.name)}
              <small>${r.extra ? "Extra part, not in any step" : r.edited ? `Automatic: ${r.auto}` : `From the steps: ${r.auto}`}${r.hidden ? " · hidden" : ""}</small>
            </span>
            ${r.hidden ? `<button class="btn secondary compact" data-show="${esc(r.id)}">Show</button>` : `
            <span class="qty">
              <button class="icon-btn small" data-minus="${esc(r.id)}" aria-label="One fewer">−</button>
              <b>${r.qty}</b>
              <button class="icon-btn small" data-plus="${esc(r.id)}" aria-label="One more">+</button>
            </span>
            ${r.edited ? `<button class="icon-btn small" data-reset="${esc(r.id)}" aria-label="Back to automatic count">↺</button>` : ""}
            <button class="icon-btn small remove" data-hide="${esc(r.id)}" aria-label="${r.extra ? "Remove part" : "Hide from materials"}">×</button>`}
          </li>`).join("")}</ul>` : ""}
        <button class="btn secondary wide" id="add-extra">+ Add a part that is not in any step</button>
      </section>
      <footer class="actions"><a class="btn primary wide" href="#/build/${esc(buildId)}">Done</a></footer>`;

    const row = id => rows.find(r => r.id === id);
    const change = async (id, qty) => {
      const r = row(id);
      if (r.extra) setExtra(build, id, qty);
      else setOverride(build, id, { qty: qty === r.auto ? null : qty });
      await saveBuild(build);
      draw();
    };
    app.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", () => change(b.dataset.plus, Math.min(999, row(b.dataset.plus).qty + 1))));
    app.querySelectorAll("[data-minus]").forEach(b => b.addEventListener("click", () => { const r = row(b.dataset.minus); if (r.qty > 1) change(r.id, r.qty - 1); }));
    app.querySelectorAll("[data-reset]").forEach(b => b.addEventListener("click", () => change(b.dataset.reset, row(b.dataset.reset).auto)));
    app.querySelectorAll("[data-hide]").forEach(b => b.addEventListener("click", async () => {
      const r = row(b.dataset.hide);
      if (r.extra) setExtra(build, r.id, 0);
      else setOverride(build, r.id, { hidden: true });
      await saveBuild(build);
      draw();
    }));
    app.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", async () => { setOverride(build, b.dataset.show, { hidden: null }); await saveBuild(build); draw(); }));
    $("#add-extra").addEventListener("click", () => { location.hash = `${here}/parts`; });
  };

  draw();
  if (picker) {
    const current = id => materials(build, library).find(r => r.id === id);
    partPicker({
      build, library, back: here,
      title: "Add to materials",
      subtitle: "Tap a part to add it to the Materials slide, tap again for more",
      count: id => { const r = current(id); return r && !r.hidden ? r.qty : 0; },
      add: id => {
        const r = current(id);
        if (!r) setExtra(build, id, 1);
        else if (r.hidden) setOverride(build, id, { hidden: null });
        else if (r.extra) setExtra(build, id, Math.min(999, r.qty + 1));
        else setOverride(build, id, { qty: Math.min(999, r.qty + 1) });
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Step editor
// ---------------------------------------------------------------------------

const pct = (v, total) => `${(v / total) * 100}%`;
const box = b => `left:${pct(b.x, 1280)};top:${pct(b.y, 720)};width:${pct(b.w, 1280)};height:${pct(b.h, 720)}`;
const fontSize = pt => `font-size:${(pt * 96 / 72 / 1280) * 100}cqw`;

// An HTML copy of the step slide, drawn with the same layout numbers as the deck.
function slidePreview(build, step, index, library, photoSrc) {
  const move = MOVES[step.move];
  const parts = move ? [] : step.parts.map(p => ({ ...p, part: library.get(p.id) })).filter(p => p.part);
  const placed = partLayout(parts, build.showPartNames);
  return `<div class="slide" aria-label="Slide preview">
    <div class="s-heading" style="${box(LAYOUT.heading)};${fontSize(LAYOUT.heading.size)}">${esc(stepHeading(index))}</div>
    <div class="s-instruction" style="${box(LAYOUT.instruction)};${fontSize(fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, 14))}">${step.instruction.trim() ? `<mark>${esc(step.instruction.trim())}</mark>` : ""}</div>
    ${move ? `<img class="s-move" src="${move.icon}" style="${box(moveIconBox())}" alt="">` : ""}
    ${parts.map(({ part, qty }, i) => {
      const { image, qtyBox, nameBox } = placed[i];
      return `<img class="s-part" src="${esc(part.file)}" style="${box(image)}" alt="">
        ${qtyBox ? `<div class="s-qty" style="${box(qtyBox)};${fontSize(LAYOUT.quantity.size)}">x${qty}</div>` : ""}
        ${nameBox ? `<div class="s-name" style="${box(nameBox)};${fontSize(fittedSize(part.name, nameBox, LAYOUT.partName.size, 8))}">${esc(part.name)}</div>` : ""}`;
    }).join("")}
    ${photoSrc ? `<img class="s-photo" src="${photoSrc}" style="${box(fit(LAYOUT.photo, step.photo.w, step.photo.h))}" alt="">`
      : `<div class="s-photo-empty" style="${box(LAYOUT.photo)}">Step photo</div>`}
  </div>`;
}

async function renderStep(buildId, stepId, { picker = false } = {}) {
  const build = await getBuild(buildId);
  const index = build?.steps.findIndex(s => s.id === stepId) ?? -1;
  if (index < 0) { location.replace(build ? `#/build/${buildId}` : "#/"); return; }
  const step = build.steps[index];
  const library = await loadParts(build.kit);
  const save = () => saveBuild(build);
  const here = `#/build/${buildId}/step/${stepId}`;

  const draw = async () => {
    const src = await photoUrl(step.photo);
    const prev = build.steps[index - 1], next = build.steps[index + 1];
    app.innerHTML = `
      <header class="bar">
        <a href="#/build/${esc(buildId)}" class="icon-btn" aria-label="Back to steps">‹</a>
        <div class="title"><h1>Step ${index + 1} <small>of ${build.steps.length}</small></h1><p>${esc(build.name)}</p></div>
        <span class="nav-steps">
          <a class="icon-btn small ${prev ? "" : "off"}" ${prev ? `href="#/build/${esc(buildId)}/step/${esc(prev.id)}"` : ""} aria-label="Previous step">‹‹</a>
          <a class="icon-btn small ${next ? "" : "off"}" ${next ? `href="#/build/${esc(buildId)}/step/${esc(next.id)}"` : ""} aria-label="Next step">››</a>
        </span>
      </header>
      <section class="page editor">
        <div class="preview">${slidePreview(build, step, index, library, src)}</div>

        <div class="field">
          <h3>1 · Step photo</h3>
          <div class="row">
            <button class="btn ${step.photo ? "secondary" : "primary"}" id="camera">${step.photo ? "Retake photo" : "Take photo"}</button>
            <button class="btn secondary" id="gallery">From gallery</button>
          </div>
        </div>

        <div class="field">
          <h3>2 · What this step does</h3>
          <div class="segmented" role="radiogroup">
            <button role="radio" aria-checked="${!MOVES[step.move]}" data-move="">Adds parts</button>
            ${Object.entries(MOVES).map(([key, m]) => `<button role="radio" aria-checked="${step.move === key}" data-move="${key}">${esc(m.label)}</button>`).join("")}
          </div>
          ${MOVES[step.move] ? `<p class="hint">No part is added. The slide shows a "${esc(MOVES[step.move].label)}" arrow where the part picture would be.</p>` : `
          <ul class="chosen">${step.parts.map((p, i) => {
            const part = library.get(p.id);
            return `<li>
              ${part ? `<img src="${esc(part.file)}" alt="">` : "<span class='missing'>?</span>"}
              <span class="name">${esc(part?.name ?? `${p.id} (not in this library)`)}</span>
              <span class="qty">
                <button class="icon-btn small" data-minus="${i}" aria-label="One fewer">−</button>
                <b>${p.qty}</b>
                <button class="icon-btn small" data-plus="${i}" aria-label="One more">+</button>
              </span>
              <button class="icon-btn small remove" data-remove="${i}" aria-label="Remove part">×</button>
            </li>`;
          }).join("")}</ul>
          <button class="btn secondary wide" id="add-part">+ Choose part from ${esc(await kitName(build.kit))}</button>`}
        </div>

        <div class="field">
          <h3>3 · Instruction</h3>
          <textarea id="instruction" rows="3" maxlength="${MAX_INSTRUCTION}" enterkeyhint="done" autocapitalize="sentences" placeholder="e.g. Take 1X4 brick and fix it on top of the technic brick">${esc(step.instruction)}</textarea>
          <p class="hint" id="count"></p>
        </div>

        <div class="row step-actions">
          <button class="btn danger-ghost" id="delete">Delete step</button>
          <button class="btn secondary" id="insert">Insert step after</button>
        </div>
      </section>
      <footer class="actions">
        <button class="btn secondary" id="next-new">📷 Next step</button>
        <a class="btn primary" href="#/build/${esc(buildId)}">Done</a>
      </footer>`;

    const count = () => {
      const n = $("#instruction").value.trim().length;
      $("#count").textContent = n > LONG_INSTRUCTION ? `${n}/${MAX_INSTRUCTION} characters: this will wrap onto a second line.` : `${n}/${MAX_INSTRUCTION} characters`;
    };
    count();
    let typing;
    $("#instruction").addEventListener("input", e => {
      step.instruction = e.target.value.replace(/\s*\n\s*/g, " ");
      count();
      const shown = $(".s-instruction");
      shown.innerHTML = step.instruction.trim() ? `<mark>${esc(step.instruction.trim())}</mark>` : "";
      shown.style.fontSize = fontSize(fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, 14)).split(":")[1];
      clearTimeout(typing);
      typing = setTimeout(save, 400);
    });
    $("#instruction").addEventListener("blur", save);
    // The instruction is one line on the slide, so Enter closes the keyboard instead.
    $("#instruction").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
    $("#camera").addEventListener("click", () => setPhoto("camera"));
    $("#gallery").addEventListener("click", () => setPhoto("gallery"));
    $("#add-part")?.addEventListener("click", () => { location.hash = `${here}/parts`; });
    app.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", async () => {
      const move = b.dataset.move || null;
      if (move === (step.move ?? null)) return;
      if (move && step.parts.length && !(await confirmDialog(`Make this a "${MOVES[move].label}" step?`, `The ${step.parts.length} part${step.parts.length === 1 ? "" : "s"} chosen for this step will be removed.`, "Change step", false))) return;
      const previous = MOVES[step.move]?.instruction;
      if (move) step.parts = [];
      step.move = move;
      // Fill in the usual wording, but never replace what the user typed.
      if (!step.instruction.trim() || step.instruction === previous) step.instruction = move ? MOVES[move].instruction : "";
      await save();
      draw();
    }));
    app.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", async () => { step.parts[b.dataset.plus].qty = Math.min(99, step.parts[b.dataset.plus].qty + 1); await save(); draw(); }));
    app.querySelectorAll("[data-minus]").forEach(b => b.addEventListener("click", async () => { const p = step.parts[b.dataset.minus]; if (p.qty > 1) { p.qty--; await save(); draw(); } }));
    app.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", async () => { step.parts.splice(b.dataset.remove, 1); await save(); draw(); }));
    $("#delete").addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete step ${index + 1}?`, "Its photo, parts and instruction will be removed. Later steps move up by one.", "Delete step"))) return;
      await removeStep(build, step);
      location.replace(`#/build/${buildId}`);
    });
    // No await before addStep: the camera must open inside the tap.
    // save() is queued before addStep reads the build, so typed text is kept.
    $("#insert").addEventListener("click", () => { clearTimeout(typing); save(); addStep(build, index + 1); });
    $("#next-new").addEventListener("click", () => { clearTimeout(typing); save(); addStep(build, index + 1); });
  };

  const setPhoto = async source => {
    try {
      const shot = await takePhoto(source);
      if (!shot) return;
      const old = step.photo;
      const photo = { id: uid(), w: shot.w, h: shot.h };
      await putImage(photo.id, shot.blob);
      step.photo = photo;
      await save();
      if (old) { forgetPhoto(old.id); await deleteImage(old.id); }
      await draw();
    } catch (error) { fail(error); }
  };

  await draw();
  if (picker) return partPicker({
    build, library, back: here,
    title: "Choose parts",
    subtitle: `Step ${index + 1} · tap a part to add it, tap again for more`,
    count: id => step.parts.find(p => p.id === id)?.qty ?? 0,
    add: id => {
      const chosen = step.parts.find(p => p.id === id);
      if (chosen) chosen.qty = Math.min(99, chosen.qty + 1);
      else step.parts.push({ id, qty: 1 });
    },
  });
}

async function removeStep(build, step) {
  build.steps = build.steps.filter(s => s.id !== step.id);
  await saveBuild(build);
  if (step.photo) { forgetPhoto(step.photo.id); await deleteImage(step.photo.id); }
}

// A new step left completely empty is dropped when the user leaves it.
async function dropIfEmpty(buildId, stepId) {
  const build = await getBuild(buildId);
  const step = build?.steps.find(s => s.id === stepId);
  if (step && !step.photo && !step.parts.length && !step.move && !step.instruction.trim()) await removeStep(build, step);
}

// ---------------------------------------------------------------------------
// Part picker
// ---------------------------------------------------------------------------

// "1x4", "1 X 4" and "1 × 4" all become 1 · x · 4. Numbers must match exactly (so 1 x 4 is not
// 1 x 16), words match from the start ("gea" finds gear).
function searchWords(text) {
  return text.toLowerCase().replace(/(\d)\s*[x×]\s*(?=\d)/g, "$1 x ").replace(/[^a-z0-9.]+/g, " ").split(" ").filter(Boolean);
}

/** count(id) → how many are chosen now (0 = none); add(id) records one more tap. */
function partPicker({ build, library, back, title, subtitle, count, add }) {
  const used = new Set(build.steps.flatMap(s => s.parts.map(p => p.id)));
  const all = [...library.values()];
  const overlay = document.createElement("div");
  overlay.className = "picker";
  overlay.innerHTML = `
    <header class="bar">
      <a href="${back}" class="icon-btn" aria-label="Close">‹</a>
      <div class="title"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
    </header>
    <div class="search"><input type="search" placeholder="Search ${all.length} parts (e.g. 1 x 4, gear, plate)" autocomplete="off"></div>
    <div class="picker-body"></div>
    <footer class="actions"><a class="btn primary wide" href="${back}">Done</a></footer>`;
  document.body.append(overlay);
  app.inert = true;
  const body = overlay.querySelector(".picker-body");
  const search = overlay.querySelector("input");

  const tile = part => {
    const chosen = count(part.id);
    return `<button class="part ${chosen ? "chosen" : ""}" data-id="${esc(part.id)}">
      <img src="${esc(part.file)}" alt="" loading="lazy">
      <span>${esc(part.name)}</span>
      ${chosen ? `<b class="badge">${chosen}</b>` : ""}
    </button>`;
  };
  const draw = () => {
    const words = searchWords(search.value);
    const match = part => { const hay = searchWords(`${part.name} ${part.kitName}`); return words.every(w => hay.some(h => /^\d/.test(w) ? h === w : h.startsWith(w))); };
    const found = all.filter(match);
    const recent = words.length ? [] : found.filter(p => used.has(p.id));
    body.innerHTML = `
      ${recent.length ? `<h3>Used in this build</h3><div class="grid">${recent.map(tile).join("")}</div><h3>All parts</h3>` : ""}
      ${found.length ? `<div class="grid">${found.map(tile).join("")}</div>` : `<p class="empty">No part matches "${esc(search.value)}".</p>`}`;
  };
  body.addEventListener("click", async e => {
    const button = e.target.closest("[data-id]");
    if (!button) return;
    add(button.dataset.id);
    await saveBuild(build);
    draw();
  });
  search.addEventListener("input", draw);
  draw();
}

function closePicker() {
  document.querySelector(".picker")?.remove();
  app.inert = false;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

let current = { stepKey: null };
async function route() {
  const path = location.hash.replace(/^#/, "");
  const parts = path.split("/").filter(Boolean);
  closePicker();
  try {
    const stepKey = parts[0] === "build" && parts[2] === "step" ? `${parts[1]}/${parts[3]}` : null;
    // Leaving a step that was never filled in removes it again.
    if (current.stepKey && current.stepKey !== stepKey) {
      const [b, s] = current.stepKey.split("/");
      await dropIfEmpty(b, s);
    }
    current.stepKey = stepKey;
    if (parts[0] === "build" && parts[1] && parts[2] === "step" && parts[3]) {
      await renderStep(parts[1], parts[3], { picker: parts[4] === "parts" });
    } else if (parts[0] === "build" && parts[1] && parts[2] === "bom") {
      await renderBom(parts[1], { picker: parts[3] === "parts" });
    } else if (parts[0] === "build" && parts[1]) {
      await renderBuild(parts[1]);
    } else {
      await renderHome();
    }
    if (!parts.includes("parts")) window.scrollTo(0, 0);
  } catch (error) { fail(error); }
}

if ("serviceWorker" in navigator && !import.meta.env.DEV) navigator.serviceWorker.register("./sw.js").catch(() => {});

window.addEventListener("hashchange", route);
keepStorage();
route();
