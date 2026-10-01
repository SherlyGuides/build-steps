import { deleteBuild, deleteImage, getBuild, getImage, keepStorage, listBuilds, photoImageIds, putImage, saveBuild, stepImageIds, uid } from "./db.js";
import { blankEdits, editPhoto, renderPhoto } from "./photo-editor.js";
import { BOM_GRIDS, DEFAULT_PHOTO, DESIGN_VERSION, LAYOUT, MAX_STEP_PARTS, applyDesignStandards, offerDesignUpdate, outdatedSteps, MOVES, photoBox, bomCell, bomStyle, countLabel, namedPart, partInPicture, bomGrid, fittedSize, isSinglePicture, partNameStyle, labelText, stepAreas, stepSplit, bomHeading, bomPages, bomRows, buildDeck, deckFileName, fit, isPartsList, materials, partLayout, stepHeading } from "./deck.js";
import { pickBuildFile, pickGalleryPhotos, preparePhoto, saveAndShare, takePhoto } from "./device.js";
import { suggestInstructions } from "./ai.js";
import { kitName, kitsOf, loadKits, loadParts } from "./library.js";
import { buildFileName, exportBuild, importBuild } from "./transfer.js";

// Screens, chosen by the address so the phone's Back button works:
//   #/                          builds on this phone
//   #/build/<id>                the steps of one build
//   #/build/<id>/step/<stepId>  edit one step (#…/parts opens the part picker on top)

const MIN_GRADE = 1, MAX_GRADE = 9, MIN_SESSION = 1, MAX_SESSION = 30;
const MAX_NAME = 80, MAX_INSTRUCTION = 200, LONG_INSTRUCTION = 110;

const app = document.getElementById("app");

// Laptops and desktops (mouse or trackpad): photos come from files, so labels say "Choose" not
// "Take", and photos can also be dropped onto the page or pasted.
const LAPTOP = matchMedia("(pointer: fine)").matches;
const L = LAPTOP
  ? { take: "Choose photo", retake: "Replace photo", addStep: "＋ Add step", nextStep: "＋ Next step", addFromGallery: "🖼 Add steps from photos" }
  : { take: "Take photo", retake: "Retake photo", addStep: "📷 Add step", nextStep: "📷 Next step", addFromGallery: "🖼 Add steps from gallery" };

// Listeners on document/window for the current screen only; route() removes them.
let screenListeners = [];
function onScreen(target, type, handler) {
  target.addEventListener(type, handler);
  screenListeners.push(() => target.removeEventListener(type, handler));
}

/** Image files from a drop or paste event. */
function imageFiles(event) {
  const items = [...(event.dataTransfer?.files ?? event.clipboardData?.files ?? [])];
  return items.filter(file => file.type.startsWith("image/"));
}

/** Show a "drop here" outline while files are dragged over the window. */
function dropTarget(label, onFiles) {
  let depth = 0;
  const show = on => document.body.classList.toggle("dropping", on);
  document.body.dataset.dropLabel = label;
  onScreen(window, "dragenter", e => { if ([...e.dataTransfer.types].includes("Files")) { depth++; show(true); } });
  onScreen(window, "dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) show(false); });
  onScreen(window, "dragover", e => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  onScreen(window, "drop", e => {
    depth = 0; show(false);
    const files = imageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  });
}
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
// ---------------------------------------------------------------------------
// Step photos: the original is kept, the slide photo is rendered from it + edits.
// ---------------------------------------------------------------------------

/** Store a new original (from camera or gallery). With edit, the photo editor opens first. */
async function newPhoto(shot, { edit, slideAspect }) {
  const original = { id: uid(), w: shot.w, h: shot.h };
  await putImage(original.id, shot.blob);
  const edited = edit ? await editPhoto(shot.blob, blankEdits(), null, { slideAspect }) : null;
  const out = edited ?? await renderPhoto(shot.blob);
  const photo = { id: uid(), w: out.w, h: out.h, original, edits: edited?.edits ?? blankEdits(), maskId: null };
  if (edited?.maskBlob) { photo.maskId = uid(); await putImage(photo.maskId, edited.maskBlob); }
  await putImage(photo.id, out.blob);
  return photo;
}

/** Reopen the editor on a step photo. Resolves to the new photo, or null if cancelled. */
async function reEditPhoto(photo, slideAspect) {
  const original = photo.original ?? { id: photo.id, w: photo.w, h: photo.h }; // photos from before the editor
  const originalBlob = await getImage(original.id);
  if (!originalBlob) throw new Error("This photo's original is missing, so it cannot be edited. Retake it instead.");
  const edited = await editPhoto(originalBlob, photo.edits, photo.maskId ? await getImage(photo.maskId) : null, { slideAspect });
  if (!edited) return null;
  const next = { id: uid(), w: edited.w, h: edited.h, original, edits: edited.edits, maskId: photo.maskId ?? null };
  if (edited.maskBlob) { next.maskId = uid(); await putImage(next.maskId, edited.maskBlob); }
  await putImage(next.id, edited.blob);
  const keep = new Set(photoImageIds(next));
  for (const id of photoImageIds(photo)) if (!keep.has(id)) { forgetPhoto(id); await deleteImage(id); }
  return next;
}

async function dropPhoto(photo) {
  for (const id of photoImageIds(photo)) { forgetPhoto(id); await deleteImage(id); }
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

async function detailsDialog(build, { list = isPartsList(build) } = {}) {
  const kits = await loadKits();
  const chosen = new Set(build ? kitsOf(build) : [kits[0].id]);
  // A kit whose parts are already used in this build can't be taken off.
  const usedIds = new Set([...(build?.steps ?? []).flatMap(s => s.parts.map(p => p.id)), ...(build?.bom?.extras ?? []).map(e => e.id)]);
  const inUse = new Set();
  for (const k of chosen) if ([...(await loadParts(k)).keys()].some(id => usedIds.has(id))) inUse.add(k);
  const range = (min, max, value) => Array.from({ length: max - min + 1 }, (_, i) => min + i)
    .map(n => `<option value="${n}" ${n === value ? "selected" : ""}>${n}</option>`).join("");
  // A parts list has no cover, so grade and session are optional (they only appear in the file name).
  const first = (chosen) => list ? `<option value="" ${chosen ? "" : "selected"}>Not set</option>` : build ? "" : '<option value="" selected disabled>Choose</option>';
  return dialog(`
    <form method="dialog" class="details">
      <h2>${list ? (build ? "BOM details" : "New BOM") : build ? "Build details" : "New build"}</h2>
      <label>${list ? "BOM name" : "Build name"}<input name="name" required maxlength="${MAX_NAME}" autocomplete="off" placeholder="${list ? "e.g. Tipper Truck parts" : "e.g. Tipper Truck"}" value="${esc(build?.name)}"></label>
      <div class="row">
        <label>Grade${list ? " (optional)" : ""}<select name="grade" ${list ? "" : "required"}>${first(build?.grade)}${range(MIN_GRADE, MAX_GRADE, build?.grade)}</select></label>
        <label>Session${list ? " (optional)" : ""}<select name="session" ${list ? "" : "required"}>${first(build?.session)}${range(MIN_SESSION, MAX_SESSION, build?.session)}</select></label>
      </div>
      <fieldset class="kit-choice"><legend>Parts libraries <span>choose one or more kits</span></legend>
        ${kits.map(k => `<label class="kit-option"><input type="checkbox" name="kits" value="${esc(k.id)}" ${chosen.has(k.id) ? "checked" : ""} ${inUse.has(k.id) ? "disabled" : ""}><span>${esc(k.name)}${inUse.has(k.id) ? " <small>parts in use</small>" : ""}</span></label>`).join("")}
      </fieldset>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancel</button>
      <button class="btn primary">${build ? "Save" : list ? "Create BOM" : "Start build"}</button></div>
    </form>`,
  (el, close) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const name = form.name.value.replace(/\s+/g, " ").trim();
      if (!name) { form.name.focus(); return; }
      const picked = kits.map(k => k.id).filter(id => inUse.has(id) || form.querySelector(`input[name="kits"][value="${id}"]`).checked);
      if (!picked.length) { toast("Choose at least one parts library."); return; }
      // kit (the first) is kept for build files opened by older versions of the app.
      close({ name, grade: form.grade.value ? Number(form.grade.value) : null, session: form.session.value ? Number(form.session.value) : null, kits: picked, kit: picked[0] });
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
    <header class="bar"><div class="brand"><span class="mark"></span><div><h1>Build PPT Designer</h1><p>Build guides and BOMs</p></div></div></header>
    <section class="page">
      ${builds.length ? `<ul class="build-list">${builds.map(b => `
        <li class="build-row"><a href="#/build/${esc(b.id)}${isPartsList(b) ? "/bom" : ""}" class="build-card">
          <strong>${isPartsList(b) ? `<i class="tag">BOM</i>` : ""}${esc(b.name)}</strong>
          <span>${b.grade && b.session ? `Grade ${b.grade} · Session ${b.session} · ` : ""}${esc(kitsOf(b).map(k => names[k] ?? k).join(" + "))}</span>
          <span class="meta">${isPartsList(b)
            ? `${(b.bom?.extras ?? []).length} part${(b.bom?.extras ?? []).length === 1 ? "" : "s"}`
            : `${b.steps.length} step${b.steps.length === 1 ? "" : "s"}`} · edited ${new Date(b.updatedAt).toLocaleDateString()}</span>
        </a><button class="icon-btn delete-build" data-delete="${esc(b.id)}" aria-label="Delete ${esc(b.name)}">🗑</button></li>`).join("")}</ul>`
      : `<div class="empty"><h2>No builds yet</h2><p>Start a build, photograph each step, pick the parts it uses and write the instruction. Generate Deck makes the PowerPoint.</p><p>Or open the <b>BOM Designer</b>: just the Materials Required slides, with the parts you choose.</p></div>`}
      <p class="source-link"><a href="https://github.com/SherlyGuides/build-steps" target="_blank" rel="noopener">Source code</a> · AGPL-3.0</p>
    </section>
    <footer class="actions">
      <button class="btn secondary" id="import">Open file</button>
      <button class="btn secondary" id="new-list">BOM Designer</button>
      <button class="btn primary" id="new">New build</button>
    </footer>`;
  app.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", async () => {
    const build = builds.find(b => b.id === button.dataset.delete);
    const what = isPartsList(build) ? "BOM" : "build";
    if (!build || !(await confirmDialog(`Delete this ${what}?`, isPartsList(build)
      ? `"${build.name}" will be removed from this phone. Decks already made are not affected.`
      : `"${build.name}" and its ${build.steps.length} step photo${build.steps.length === 1 ? "" : "s"} will be removed from this phone. Decks already made are not affected. Save a build file first (⋯ → Save build file) if you may want it back.`, "Delete"))) return;
    build.steps.forEach(s => stepImageIds(s).forEach(forgetPhoto));
    await deleteBuild(build);
    toast(`"${build.name}" deleted.`);
    renderHome();
  }));
  $("#new").addEventListener("click", async () => {
    const details = await detailsDialog(null);
    if (!details) return;
    const build = { id: uid(), ...details, deckVersion: 1, designVersion: DESIGN_VERSION, steps: [], createdAt: Date.now() };
    await saveBuild(build);
    location.hash = `#/build/${build.id}`;
  });
  $("#new-list").addEventListener("click", async () => {
    const details = await detailsDialog(null, { list: true });
    if (!details) return;
    const list = { id: uid(), kind: "bom", ...details, deckVersion: 1, designVersion: DESIGN_VERSION, steps: [], bom: { overrides: {}, extras: [] }, createdAt: Date.now() };
    await saveBuild(list);
    // Straight to choosing parts.
    history.pushState(null, "", `#/build/${list.id}/bom`);
    location.hash = `#/build/${list.id}/bom/parts`;
  });
  $("#import").addEventListener("click", async () => {
    const file = await pickBuildFile();
    if (!file) return;
    try {
      const build = await importBuild(file);
      toast(isPartsList(build) ? `BOM "${build.name}" opened.` : `"${build.name}" opened with ${build.steps.length} steps.`);
      location.hash = `#/build/${build.id}${isPartsList(build) ? "/bom" : ""}`;
    } catch (error) { fail(error); }
  });
}

// ---------------------------------------------------------------------------
// Build: the list of steps
// ---------------------------------------------------------------------------

function stepIssues(step) {
  return [!step.photo && "no photo", !step.parts.length && !MOVES[step.move] && !step.leftPhoto && !isSinglePicture(step) && "no parts", !step.instruction.trim() && "no instruction"].filter(Boolean);
}

async function renderBuild(buildId) {
  const build = await getBuild(buildId);
  if (!build) { location.replace("#/"); return; }
  if (isPartsList(build)) { location.replace(`#/build/${buildId}/bom`); return; }
  const library = await loadParts(kitsOf(build));
  const thumbs = await Promise.all(build.steps.map(s => photoUrl(s.photo)));
  const incomplete = build.steps.filter(s => stepIssues(s).length).length;
  const bom = bomRows(build, library);
  const edited = materials(build, library).some(r => r.edited || r.hidden || r.extra);
  const pieces = bom.reduce((sum, r) => sum + r.qty, 0);

  app.innerHTML = `
    <header class="bar">
      <a href="#/" class="icon-btn" aria-label="All builds">‹</a>
      <div class="title"><h1>${esc(build.name)}</h1><p>Grade ${build.grade} · Session ${build.session} · ${esc(await kitName(kitsOf(build)))}</p></div>
      <button class="icon-btn" id="menu" aria-label="Build options">⋯</button>
    </header>
    <section class="page">
      ${offerDesignUpdate(build) ? `<div class="design-update">
        <p><strong>New design standards</strong> This build was made before the latest design standards${outdatedSteps(build).length ? ` (${outdatedSteps(build).length} step${outdatedSteps(build).length === 1 ? " uses" : "s use"} the older layout)` : ""}. Update to the latest: parts 20% / photo 80%, part names with counts ("Plate 2 x 2 - 2") at ${LAYOUT.partName.default} pt.</p>
        <div><button class="btn primary compact" id="design-update">Update design to latest design standards</button><button class="link" id="design-keep">Keep my layout</button></div>
      </div>` : ""}
      <a class="bom-card" href="#/build/${esc(build.id)}/bom">
        <span class="bom-head"><strong>Materials required</strong><span>Slide 2${bomPages(bom, bomGrid(build)).length > 1 ? `–${bomPages(bom, bomGrid(build)).length + 1}` : ""}</span></span>
        ${bom.length ? `<span class="bom-thumbs">${bom.slice(0, 6).map(r => `<span><img src="${esc(r.part.file)}" alt=""><b>${r.qty}</b></span>`).join("")}${bom.length > 6 ? `<em>+${bom.length - 6}</em>` : ""}</span>
        <span class="meta">${bom.length} part${bom.length === 1 ? "" : "s"} · ${pieces} piece${pieces === 1 ? "" : "s"}${edited ? " · edited" : " · worked out from the steps"}</span>`
        : `<span class="meta">Filled in automatically from the parts you choose in each step.</span>`}
        <span class="bom-edit">Review &amp; edit BOM ›</span>
      </a>
      <h2 class="section-title">Build steps <span>from slide ${bomPages(bom, bomGrid(build)).length + 2}</span></h2>
      ${build.steps.length ? `<ol class="step-list">${build.steps.map((step, i) => {
        const issues = stepIssues(step);
        return `<li class="step-card" data-step="${esc(step.id)}">
          <button class="step-open" data-open="${esc(step.id)}">
            <span class="step-no">${i + 1}</span>
            <span class="step-thumb">${thumbs[i] ? `<img src="${thumbs[i]}" alt="">` : "<em>No photo</em>"}</span>
            <span class="step-body">
              <span class="step-text">${esc(step.instruction) || "<em>No instruction yet</em>"}</span>
              <span class="step-parts">${MOVES[step.move] ? `<i>↻ ${MOVES[step.move].label}</i>` : ""}${MOVES[step.move] ? "" : step.parts.map(p => library.get(p.id)).filter(Boolean).slice(0, 4).map(p => `<img src="${esc(p.file)}" alt="${esc(p.name)}">`).join("")}${!MOVES[step.move] && step.parts.length > 4 ? `<b>+${step.parts.length - 4}</b>` : ""}</span>
              ${issues.length ? `<span class="warn">${issues.join(" · ")}</span>` : ""}
            </span>
          </button>
          <span class="step-move">
            <button class="icon-btn small" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move step ${i + 1} up">↑</button>
            <button class="icon-btn small" data-down="${i}" ${i === build.steps.length - 1 ? "disabled" : ""} aria-label="Move step ${i + 1} down">↓</button>
          </span>
        </li>`;
      }).join("")}</ol>`
      : `<div class="empty"><h2>Add the first step</h2><p>Photograph the model after the step, choose the part it uses from the ${esc(await kitName(kitsOf(build)))} list and type the instruction exactly as it should appear on the slide.</p></div>`}
      <button class="btn secondary wide gallery-add" id="gallery-add">${L.addFromGallery}</button>
      <p class="hint center">Select one or more photos: each becomes a step, in the order you select them.${LAPTOP ? " You can also drag photos onto this page." : ""}</p>
    </section>
    <footer class="actions">
      <button class="btn secondary" id="add">${L.addStep}</button>
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
  dropTarget("Drop photos to add them as new steps", files => addStepsFromGallery(build, files));
  $("#generate").addEventListener("click", () => generate(build, incomplete));
  $("#menu").addEventListener("click", () => buildMenu(build));
  $("#design-update")?.addEventListener("click", async () => { if (await updateDesign(build)) renderBuild(build.id); });
  $("#design-keep")?.addEventListener("click", async () => {
    build.designVersion = DESIGN_VERSION;   // stop asking; the update stays in the ⋯ menu
    await saveBuild(build);
    renderBuild(build.id);
  });
}

// Called straight from a tap: the camera opens first (browsers only allow that from a tap),
// then the new step opens with the part list, so each step is photo → part → instruction.
/** Width ÷ height of a step's photo area, for the photo editor's "Slide" crop. */
function slideAspectOf(step) {
  if (isSinglePicture(step)) return LAYOUT.single.w / LAYOUT.single.h;
  const { photo } = stepAreas(step);
  return photo.w / photo.h;
}

/** Width ÷ height of the left side, for a custom left picture's "Slide" crop. */
function leftAspectOf(step) {
  const { parts } = stepAreas(step);
  return parts.w / parts.h;
}

/** Slide settings a new step copies from the step before it, so a long build keeps one layout. */
function inheritedLayout(build, at) {
  const before = build.steps[at - 1];
  return before ? { split: before.split, partName: before.partName ? { ...before.partName } : undefined } : {};
}

async function addStep(build, at) {
  const shooting = takePhoto("camera").catch(error => { fail(error); return null; });
  const step = { id: uid(), instruction: "", move: null, parts: [], onto: [], photo: null, ...inheritedLayout(build, at) };
  const shot = await shooting;
  if (shot) {
    try { step.photo = await newPhoto(shot, { edit: true, slideAspect: slideAspectOf(step) }); } catch (error) { fail(error); }
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
async function addStepsFromGallery(build, dropped = null) {
  const files = dropped ?? await pickGalleryPhotos();
  if (!files.length) return;
  const steps = [];
  try {
    for (const [i, file] of files.entries()) {
      busy(true, `Adding photo ${i + 1} of ${files.length}…`);
      const photo = await newPhoto(await preparePhoto(file), { edit: false });
      steps.push({ id: uid(), instruction: "", move: null, parts: [], onto: [], photo, ...inheritedLayout(build, build.steps.length) });
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

/** Ask, then put every step of the build on the current design defaults. Resolves true if done. */
async function updateDesign(build) {
  const count = outdatedSteps(build).length;
  if (!(await confirmDialog("Update design to latest design standards?",
    `${count ? `${count} step${count === 1 ? "" : "s"} will change to` : "Every step will use"} the latest layout: parts take 20% of the width and the photo 80%, and each part shows its name and count ("Plate 2 x 2 - 2") at ${LAYOUT.partName.default} pt. Photos, parts and instructions stay the same. You can still adjust any step afterwards.`,
    "Update design", false))) return false;
  applyDesignStandards(build);
  await saveBuild(build);
  toast("Design updated to the latest standards.");
  return true;
}

async function buildMenu(build) {
  const list = isPartsList(build);
  const choice = await dialog(`
    <h2>${esc(build.name)}</h2>
    <div class="menu">
      <button class="btn secondary" data-choice="details">${list ? "Edit name, grade, session" : "Edit name, grade, session"}</button>
      ${list || !build.steps.length ? "" : `<button class="btn secondary" data-choice="design">Update design to latest design standards</button>`}
      <button class="btn secondary" data-choice="export">Save ${list ? "list" : "build"} file (backup / another device)</button>
      <button class="btn danger-ghost" data-choice="delete">Delete ${list ? "BOM" : "build"}</button>
    </div>
    <div class="dialog-actions"><button class="btn ghost" data-close>Close</button></div>`,
  (el, close) => el.querySelectorAll("[data-choice]").forEach(b => b.addEventListener("click", () => close(b.dataset.choice))));

  if (choice === "design") {
    if (await updateDesign(build)) renderBuild(build.id);
  } else if (choice === "details") {
    const details = await detailsDialog(build);
    if (!details) return;
    Object.assign(build, details);
    await saveBuild(build);
    list ? renderBom(build.id) : renderBuild(build.id);
  } else if (choice === "export") {
    try {
      busy(true, "Packing the build file…");
      const blob = await exportBuild(build);
      busy(false);
      await offerFile(blob, buildFileName(build), build.name, list ? "List file ready" : "Build file ready");
    } catch (error) { busy(false); fail(error); }
  } else if (choice === "delete") {
    if (!(await confirmDialog(`Delete this ${list ? "BOM" : "build"}?`, list ? `"${build.name}" will be removed from this phone. Decks already made are not affected.` : `"${build.name}" and its ${build.steps.length} step photos will be removed from this phone. Decks already made are not affected.`, "Delete"))) return;
    build.steps.forEach(s => stepImageIds(s).forEach(forgetPhoto));
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

// Preview only: the shadow under a part, placed from the usual white margin of the library
// pictures (about 5.5% each side, 6.7% below). The deck finds the exact edges.
function partShadow(p) {
  const sh = LAYOUT.bom.shadow, visible = p.w * 0.89, w = visible * sh.width, h = visible * sh.height;
  return { x: p.x + (p.w - w) / 2, y: p.y + p.h * 0.933 - h / 2, w, h };
}

function bomSlidePreview(rows, page, pageCount, grid, look) {
  return `<div class="slide bom-slide" style="background-image:url(slides/${look.tint.background}.jpg)" aria-label="Materials slide preview">
    <div class="s-heading" style="${box(LAYOUT.heading)};${fontSize(LAYOUT.heading.size)}">${esc(bomHeading(page, pageCount))}</div>
    ${rows.map(({ part, qty }, i) => {
      const c = bomCell(i, part, grid, qty, look.pieces);
      return `<div class="s-card" style="${box(c.card)}"></div>
        ${c.pictures.map(pic => partInPicture(pic, part)).map(p => `<div class="s-shadow" style="${box(partShadow(p))}"></div>
        <img class="s-part s-bom-part" src="${esc(part.file)}" style="${box(p)}" alt="">`).join("")}
        <div class="s-bom-name" style="${box(c.name)};${fontSize(fittedSize(part.name, c.name, c.nameSize, c.nameMin))}">${esc(part.name)}</div>
        <div class="s-count" style="${box(c.count)};${fontSize(c.countSize)}">${esc(countLabel(qty))}</div>`;
    }).join("")}
    ${rows.length ? "" : `<div class="s-photo-empty" style="${box(LAYOUT.bom.area)}">Parts chosen in the steps appear here</div>`}
  </div>`;
}

/** Ask for a part's name in this build. Resolves to the new name, "" for the library name, or null. */
function renameDialog(part) {
  const renamed = part.name !== part.libraryName;
  return dialog(`
    <form method="dialog" class="details">
      <h2>Rename part</h2>
      <p class="hint">Changes the name on this build's slides only. The parts library keeps "${esc(part.libraryName)}".</p>
      <label>Name<input name="name" required maxlength="80" autocomplete="off" value="${esc(part.name)}"></label>
      <div class="dialog-actions">${renamed ? `<button type="button" class="btn ghost" data-library>Use library name</button>` : ""}
      <button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`,
  (el, close) => {
    const form = el.querySelector("form");
    el.querySelector("[data-library]")?.addEventListener("click", () => close(""));
    form.addEventListener("submit", e => {
      e.preventDefault();
      const name = form.name.value.replace(/\s+/g, " ").trim();
      if (!name) { form.name.focus(); return; }
      close(name);
    });
    requestAnimationFrame(() => form.name.select());
  });
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
  const library = await loadParts(kitsOf(build));
  const here = `#/build/${buildId}/bom`;
  const list = isPartsList(build);   // a standalone parts list: only Materials slides, parts chosen by hand
  const kit = await kitName(kitsOf(build));

  const draw = () => {
    const rows = materials(build, library);
    const grid = bomGrid(build), perSlide = grid.cols * grid.rows, look = bomStyle(build);
    const pages = bomPages(rows.filter(r => !r.hidden && r.qty > 0), grid);
    const pieces = rows.filter(r => !r.hidden).reduce((sum, r) => sum + r.qty, 0);
    app.innerHTML = `
      <header class="bar">
        <a href="${list ? "#/" : `#/build/${esc(buildId)}`}" class="icon-btn" aria-label="${list ? "All builds" : "Back to steps"}">‹</a>
        <div class="title"><h1>${list ? esc(build.name) : "Materials required"}</h1><p>${list
          ? `BOM · ${rows.length} part${rows.length === 1 ? "" : "s"} · ${pieces} piece${pieces === 1 ? "" : "s"}`
          : `${esc(build.name)} · ${pages.length > 1 ? `slides 2–${pages.length + 1}` : "slide 2"}`}</p></div>
        ${list ? `<button class="icon-btn" id="menu" aria-label="List options">⋯</button>` : ""}
      </header>
      <section class="page editor">
        <div class="bom-previews">${(pages.length ? pages : [[]]).map((page, i) => bomSlidePreview(page, i, pages.length, grid, look)).join("")}</div>
        <div class="bom-grid">
          <h4>Grid <span>columns × rows · parts per slide</span></h4>
          <div class="grid-chips" role="radiogroup" aria-label="Grid size">${BOM_GRIDS.map(g => `<button role="radio" aria-checked="${g.cols === grid.cols && g.rows === grid.rows}" data-grid="${g.cols}x${g.rows}"><b>${g.cols}×${g.rows}</b><small>${g.cols * g.rows}</small></button>`).join("")}</div>
          <h4>Page</h4>
          <div class="tint-chips" role="radiogroup" aria-label="Page colour">${LAYOUT.bom.tints.map(t => `<button role="radio" aria-checked="${t.id === look.tint.id}" data-tint="${t.id}"><i style="background:${t.swatch}"></i>${t.label}</button>`).join("")}</div>
          <h4>Parts</h4>
          <div class="segmented" role="radiogroup" aria-label="How parts are shown">
            <button role="radio" aria-checked="${!look.pieces}" data-pieces="0">One picture + count</button>
            <button role="radio" aria-checked="${look.pieces}" data-pieces="1">Show every piece</button>
          </div>
          ${look.pieces ? `<p class="hint">Each part is drawn once per piece, up to ${LAYOUT.bom.maxCopies}; parts needed more often are shown once with their count.</p>` : ""}
        </div>
        <p class="hint">${list
          ? `The deck has only the Materials Required slide${pages.length > 1 ? "s" : ""}: no cover, steps or closing slide. Choose the parts and how many of each are needed.${pages.length > 1 ? ` More than ${perSlide} parts continue on another slide.` : ""}`
          : `Quantities are added up from the steps automatically and stay up to date when steps change. Change a number, hide a part or add an extra one here; <b>↺</b> goes back to the automatic count.${pages.length > 1 ? ` More than ${perSlide} parts continue on another Materials slide.` : ""}`}</p>
        ${rows.length ? `<ul class="chosen bom-rows">${rows.map(r => `
          <li class="${r.hidden ? "hidden-row" : ""}">
            <img src="${esc(r.part.file)}" alt="">
            <span class="name"><button class="rename" data-rename="${esc(r.id)}" aria-label="Rename ${esc(r.part.name)}">${esc(r.part.name)} <i>✎</i></button>
              ${r.part.name !== r.part.libraryName ? `<small>Library name: ${esc(r.part.libraryName)}</small>` : ""}
              ${list ? "" : `<small>${r.extra ? "Extra part, not in any step" : r.edited ? `Automatic: ${r.auto}` : `From the steps: ${r.auto}`}${r.hidden ? " · hidden" : ""}</small>`}
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
        <button class="btn secondary wide" id="add-extra">${list ? `+ Choose parts from ${esc(kit)}` : "+ Add a part that is not in any step"}</button>
        ${list ? `<button class="link" id="add-all" ${rows.length >= library.size ? "hidden" : ""}>Add all ${library.size} parts (×1 each)</button>` : ""}
      </section>
      <footer class="actions">${list
        ? `<a class="btn secondary" href="#/">Done</a><button class="btn primary" id="gen-list" ${pages.length ? "" : "disabled"}>Generate deck</button>`
        : `<a class="btn primary wide" href="#/build/${esc(buildId)}">Done</a>`}</footer>`;

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
    app.querySelectorAll("[data-rename]").forEach(b => b.addEventListener("click", async () => {
      const part = row(b.dataset.rename).part;
      const name = await renameDialog(part);
      if (name == null) return;
      const names = { ...build.partNames };
      if (name && name !== part.libraryName) names[part.id] = name; else delete names[part.id];
      build.partNames = names;
      await saveBuild(build);
      draw();
    }));
    $("#add-extra").addEventListener("click", () => { location.hash = `${here}/parts`; });
    const setStyle = async change => { build.bomStyle = { ...build.bomStyle, ...change }; await saveBuild(build); draw(); };
    app.querySelectorAll("[data-tint]").forEach(b => b.addEventListener("click", () => setStyle({ tint: b.dataset.tint })));
    app.querySelectorAll("[data-pieces]").forEach(b => b.addEventListener("click", () => setStyle({ pieces: b.dataset.pieces === "1" })));
    app.querySelectorAll("[data-grid]").forEach(b => b.addEventListener("click", async () => {
      const [cols, rows] = b.dataset.grid.split("x").map(Number);
      build.bomGrid = { cols, rows };
      await saveBuild(build);
      draw();
    }));
    if (list) {
      $("#menu").addEventListener("click", () => buildMenu(build));
      $("#gen-list").addEventListener("click", () => generate(build, 0));
      $("#add-all")?.addEventListener("click", async () => {
        for (const part of library.values()) if (!materials(build, library).some(r => r.id === part.id)) setExtra(build, part.id, 1);
        await saveBuild(build);
        draw();
      });
    }
  };

  draw();
  if (picker) {
    const current = id => materials(build, library).find(r => r.id === id);
    partPicker({
      build, library, back: here,
      title: list ? "Choose parts" : "Add to materials",
      subtitle: list ? "Tap a part to add it, tap again for more" : "Tap a part to add it to the Materials slide, tap again for more",
      count: id => { const r = current(id); return r && !r.hidden ? r.qty : 0; },
      add: id => {
        const r = current(id);
        if (!r) setExtra(build, id, 1);
        else if (r.hidden) setOverride(build, id, { hidden: null });
        else if (r.extra) setExtra(build, id, Math.min(999, r.qty + 1));
        else setOverride(build, id, { qty: Math.min(999, r.qty + 1) });
      },
      remove: id => {
        const r = current(id);
        if (!r || r.hidden) return;
        if (r.extra) setExtra(build, id, r.qty - 1);                       // 0 removes it
        else if (r.qty > 1) setOverride(build, id, { qty: r.qty - 1 === r.auto ? null : r.qty - 1 });
        else setOverride(build, id, { hidden: true });                     // a part from the steps is hidden, not deleted
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
function slidePreview(build, step, index, library, photoSrc, beforeSrc, leftSrc, picSrcs = {}) {
  const move = MOVES[step.move];
  const single = isSinglePicture(step);
  const left = single ? null : step.leftPhoto;
  // A part picture edited for this step replaces the library picture on this slide only.
  const parts = move || left || single ? [] : step.parts.map(p => {
    const part = namedPart(build, library.get(p.id));
    if (!part) return null;
    return { ...p, part: p.pic && picSrcs[p.id] ? { ...part, file: picSrcs[p.id], w: p.pic.w, h: p.pic.h } : part };
  }).filter(Boolean);
  const areas = stepAreas(step), names = partNameStyle(step, build);
  const placed = partLayout(parts, names, areas.parts, photoBox(step, step.photo ?? DEFAULT_PHOTO).x - 24);
  return `<div class="slide" aria-label="Slide preview">
    <div class="s-heading" style="${box(LAYOUT.heading)};${fontSize(LAYOUT.heading.size)}">${esc(stepHeading(index))}</div>
    <div class="s-instruction" style="${box(LAYOUT.instruction)};${fontSize(fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, LAYOUT.instruction.minSize))}">${step.instruction.trim() ? `<mark>${esc(step.instruction.trim())}</mark>` : ""}</div>
    ${left ? (leftSrc ? `<img class="s-photo" src="${leftSrc}" style="${box(fit(areas.parts, left.w, left.h))}" alt="">` : "") : ""}
    ${move && !left && !single ? (beforeSrc ? `<img class="s-photo" src="${beforeSrc}" style="${box(fit(areas.parts, build.steps[index - 1].photo.w, build.steps[index - 1].photo.h))}" alt="">`
      : `<div class="s-photo-empty" style="${box(areas.parts)}">${index ? "Previous step has no photo" : "Before"}</div>`) : ""}
    ${parts.map(({ part, qty }, i) => {
      const { image, label, labelBox, align } = placed[i];
      return `<img class="s-part" src="${esc(part.file)}" style="${box(image)}" alt="">
        ${labelBox ? `<div class="s-name ${align === "left" ? "s-name-right" : ""}" style="${box(labelBox)};${fontSize(fittedSize(labelText(label), labelBox, names.size, LAYOUT.partName.minSize))}">${label.map(r => r.count ? `<b>${esc(r.text)}</b>` : esc(r.text)).join("")}</div>` : ""}`;
    }).join("")}
    ${photoSrc ? `<img class="s-photo" src="${photoSrc}" style="${box(photoBox(step, step.photo))}" alt="">`
      : `<div class="s-photo-empty" style="${box(single ? LAYOUT.single : areas.photo)}">${move && !single ? "Photo after the move" : "Step photo"}</div>`}
  </div>`;
}

/** The step preview with every picture it needs looked up. */
async function stepPreview(build, step, index, library) {
  const picSrcs = {};
  for (const p of step.parts) if (p.pic) picSrcs[p.id] = await photoUrl(p.pic);
  return slidePreview(build, step, index, library, await photoUrl(step.photo),
    MOVES[step.move] ? await photoUrl(build.steps[index - 1]?.photo) : "", await photoUrl(step.leftPhoto), picSrcs);
}

async function renderStep(buildId, stepId, { picker = false } = {}) {
  const build = await getBuild(buildId);
  const index = build?.steps.findIndex(s => s.id === stepId) ?? -1;
  if (index < 0) { location.replace(build ? `#/build/${buildId}` : "#/"); return; }
  const step = build.steps[index];
  const library = await loadParts(kitsOf(build));
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
        <div class="preview">${await stepPreview(build, step, index, library)}</div>

        <div class="field">
          <h3>1 · Step photo</h3>
          ${step.photo ? `<button class="btn primary wide" id="edit-photo">✏️ Edit photo · crop, background, marks</button>` : ""}
          <div class="row">
            <button class="btn ${step.photo ? "secondary" : "primary"}" id="camera">${step.photo ? L.retake : L.take}</button>
            ${LAPTOP ? "" : `<button class="btn secondary" id="gallery">From gallery</button>`}
          </div>
        </div>

        <div class="field">
          <h3>2 · What this step does</h3>
          <div class="segmented" role="radiogroup">
            <button role="radio" aria-checked="${!MOVES[step.move]}" data-move="">Adds parts</button>
            <button role="radio" aria-checked="${!!MOVES[step.move]}" data-move="prev">${esc(MOVES.prev.label)}</button>
          </div>
          ${MOVES[step.move] ? `<p class="hint">No part is added. The slide shows two photos: the previous step's photo on the left (before) and this step's photo on the right (after), for example when the model is flipped or turned.${index && !build.steps[index - 1].photo ? " <b>The previous step has no photo yet.</b>" : ""}</p>` : `
          <ul class="chosen">${(await Promise.all(step.parts.map(async (p, i) => {
            const part = library.get(p.id);
            const thumb = p.pic ? await photoUrl(p.pic) : part?.file;
            return `<li>
              ${part ? `<img src="${esc(thumb)}" alt="">` : "<span class='missing'>?</span>"}
              <span class="name">${esc(part?.name ?? `${p.id} (not in this library)`)}${p.pic ? `<small class="edited">Picture edited for this slide · <button class="link" data-pic-reset="${i}">↺ original</button></small>` : ""}</span>
              ${part ? `<button class="icon-btn small" data-pic-edit="${i}" aria-label="Edit this part's picture for this slide only" title="Edit picture for this slide only">✏️</button>` : ""}
              <span class="qty">
                <button class="icon-btn small" data-minus="${i}" aria-label="One fewer">−</button>
                <b>${p.qty}</b>
                <button class="icon-btn small" data-plus="${i}" aria-label="One more">+</button>
              </span>
              <button class="icon-btn small remove" data-remove="${i}" aria-label="Remove part">×</button>
            </li>`;
          }))).join("")}</ul>
          <button class="btn secondary wide" id="add-part">+ Choose part from ${esc(await kitName(kitsOf(build)))}</button>
          ${index ? `<div class="onto">
            <h4>Goes onto <span>optional · tells the AI where it attaches</span></h4>
            <div class="onto-chips">${earlierParts(build, index, library).map(part => `<button class="onto-chip ${step.onto?.includes(part.id) ? "on" : ""}" data-onto="${esc(part.id)}"><img src="${esc(part.file)}" alt="">${esc(part.name)}</button>`).join("") || `<p class="hint">Parts from earlier steps appear here.</p>`}</div>
          </div>` : ""}`}
        </div>

        <div class="field">
          <h3>3 · Instruction</h3>
          <textarea id="instruction" rows="3" maxlength="${MAX_INSTRUCTION}" enterkeyhint="done" autocapitalize="sentences" spellcheck="true" autocorrect="on" lang="en" placeholder="e.g. Take 1X4 brick and fix it on top of the technic brick">${esc(step.instruction)}</textarea>
          <p class="hint" id="count"></p>
          <button class="btn secondary wide ai-btn" id="ai">${step.instruction.trim() ? "✨ Improve with AI" : "✨ Write with AI"}</button>
          <div id="ai-out" class="ai-out" aria-live="polite"></div>
          ${MOVES[step.move] ? "" : `
          <label class="switch"><input type="checkbox" id="pn-show" ${partNameStyle(step).show ? "checked" : ""}><span></span> Show part names</label>
          <div class="segmented" role="radiogroup" aria-label="Where the part label goes">
            <button role="radio" aria-checked="${!partNameStyle(step).below}" data-pn-pos="">Beside the part</button>
            <button role="radio" aria-checked="${partNameStyle(step).below}" data-pn-pos="below">Under the part</button>
          </div>
          <p class="hint">Each part is labelled "Plate 2 x 2 - 2", or just the name for a single piece. With names off, only "x 2" is shown. Label size:</p>
          <div class="pe-size" id="pn-sizes" role="radiogroup" aria-label="Part label size">
            ${LAYOUT.partName.sizes.map((pt, i) => `<button role="radio" aria-checked="${partNameStyle(step, build).size === pt}" data-pn-size="${pt}">${["Small", "Medium", "Large", "Extra large"][i]} <small>${pt} pt</small></button>`).join("")}
          </div>`}
        </div>

        <div class="field">
          <h3>4 · Slide layout</h3>
          <div class="segmented" role="radiogroup" aria-label="Pictures on the slide">
            <button role="radio" aria-checked="${!isSinglePicture(step)}" data-layout="">Two pictures</button>
            <button role="radio" aria-checked="${isSinglePicture(step)}" data-layout="single">One picture, centred</button>
          </div>
          ${isSinglePicture(step) ? `<p class="hint">Only the step photo is shown, centred. ${MOVES[step.move] ? "The before photo" : "Part pictures"} and any custom left picture are left out; the parts still count in the BOM.</p>` : `
          <label class="split">
            <span><b id="split-label"></b></span>
            <input type="range" id="split" min="${LAYOUT.split.min * 100}" max="${LAYOUT.split.max * 100}" step="1" value="${Math.round(stepSplit(step) * 100)}">
            <span class="split-ends"><span>${MOVES[step.move] ? "Bigger this step" : "Bigger photo"}</span><span>Equal</span><span>${MOVES[step.move] ? "Bigger previous image" : "Bigger part"}</span></span>
          </label>
          <div class="left-pic">
            <h4>Left side <span>${step.leftPhoto ? "custom picture" : MOVES[step.move] ? "previous step's photo" : "part pictures"}</span></h4>
            ${step.leftPhoto ? `
            <div class="row">
              <button class="btn secondary" id="left-edit">✏️ Edit</button>
              <button class="btn secondary" id="left-replace">${L.retake}</button>
              <button class="btn danger-ghost" id="left-remove">Remove</button>
            </div>` : `
            <div class="row">
              <button class="btn secondary" id="left-camera">${LAPTOP ? "Choose custom picture" : "📷 Custom picture"}</button>
              ${LAPTOP ? "" : `<button class="btn secondary" id="left-gallery">From gallery</button>`}
            </div>
            <p class="hint">Use your own picture on the left instead of the ${MOVES[step.move] ? "previous step's photo" : "part pictures"}, for example a sub-assembly or a part that is not in the library.</p>`}
          </div>`}
          ${MOVES[step.move] || isSinglePicture(step) ? "" : `<button class="link" id="layout-all">Use this layout for all steps</button>`}
        </div>

        <div class="row step-actions">
          <button class="btn danger-ghost" id="delete">Delete step</button>
          <button class="btn secondary" id="insert">Insert step after</button>
        </div>
      </section>
      <footer class="actions">
        <button class="btn secondary" id="next-new">${L.nextStep}</button>
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
      shown.style.fontSize = fontSize(fittedSize(step.instruction.trim(), LAYOUT.instruction, LAYOUT.instruction.size, LAYOUT.instruction.minSize)).split(":")[1];
      clearTimeout(typing);
      typing = setTimeout(save, 400);
    });
    $("#instruction").addEventListener("blur", save);
    // Grammarly and other writing tools may replace the text without a keystroke: save that too.
    $("#instruction").addEventListener("change", e => {
      step.instruction = e.target.value.replace(/\s*\n\s*/g, " ");
      count();
      save();
    });
    // The instruction is one line on the slide, so Enter closes the keyboard instead.
    $("#instruction").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
    $("#instruction").addEventListener("input", () => { $("#ai").textContent = $("#instruction").value.trim() ? "✨ Improve with AI" : "✨ Write with AI"; });
    $("#ai").addEventListener("click", async () => {
      const button = $("#ai"), out = $("#ai-out");
      button.disabled = true;
      out.innerHTML = `<p class="hint">Asking the AI…</p>`;
      try {
        const named = parts => parts.map(p => ({ name: namedPart(build, library.get(p.id))?.name ?? "", qty: p.qty })).filter(p => p.name);
        const suggestions = await suggestInstructions({
          instruction: step.instruction,
          parts: MOVES[step.move] ? [] : named(step.parts),
          move: step.move,
          grade: build.grade,
          step: index + 1,
          // What is already built, so the AI can say which part the new one goes onto.
          history: build.steps.slice(Math.max(0, index - 8), index).map((s, i, list) => ({ step: index - list.length + i + 1, parts: named(s.parts), move: s.move })),
          onto: MOVES[step.move] ? [] : (step.onto ?? []).map(id => namedPart(build, library.get(id))?.name).filter(Boolean),
          photo: step.photo ? await getImage(step.photo.id) : null,
        });
        out.innerHTML = `${suggestions.map((s, i) => `<button class="ai-card" data-ai="${i}"><b>${esc(s.label)}</b>${esc(s.text)}</button>`).join("")}
          <p class="hint">Tap one to use it. You can still edit it afterwards.</p>`;
        out.querySelectorAll("[data-ai]").forEach(card => card.addEventListener("click", () => {
          const before = step.instruction;
          const box = $("#instruction");
          box.value = suggestions[+card.dataset.ai].text;
          box.dispatchEvent(new Event("input"));
          save();
          out.innerHTML = `<p class="hint">Instruction replaced. <button class="link" id="ai-undo">Undo</button></p>`;
          $("#ai-undo").addEventListener("click", () => { box.value = before; box.dispatchEvent(new Event("input")); save(); out.innerHTML = ""; });
        }));
      } catch (error) {
        out.innerHTML = `<p class="hint error">${esc(error.message)}</p>`;
      } finally {
        button.disabled = false;
      }
    });
    $("#camera").addEventListener("click", () => setPhoto("camera"));
    $("#gallery")?.addEventListener("click", () => setPhoto("gallery"));
    $("#edit-photo")?.addEventListener("click", async () => {
      try {
        const next = await reEditPhoto(step.photo, slideAspectOf(step));
        if (!next) return;
        step.photo = next;
        await save();
        await draw();
      } catch (error) { fail(error); }
    });
    $("#add-part")?.addEventListener("click", () => { location.hash = `${here}/parts`; });
    // Slide layout and part names: update the preview straight away, save as they change.
    const refreshPreview = async () => {
      $(".preview").innerHTML = await stepPreview(build, step, index, library);
    };
    app.querySelectorAll("[data-layout]").forEach(b => b.addEventListener("click", async () => {
      step.layout = b.dataset.layout || undefined;
      await save(); draw();
    }));
    const setLeft = async (source, file = null) => {
      try {
        const shot = file ? await preparePhoto(file) : await takePhoto(source);
        if (!shot) return;
        const old = step.leftPhoto;
        step.leftPhoto = await newPhoto(shot, { edit: true, slideAspect: leftAspectOf(step) });
        await save();
        if (old) await dropPhoto(old);
        await draw();
      } catch (error) { fail(error); }
    };
    $("#left-camera")?.addEventListener("click", () => setLeft("camera"));
    $("#left-gallery")?.addEventListener("click", () => setLeft("gallery"));
    $("#left-replace")?.addEventListener("click", () => setLeft("camera"));
    $("#left-edit")?.addEventListener("click", async () => {
      try {
        const next = await reEditPhoto(step.leftPhoto, leftAspectOf(step));
        if (!next) return;
        step.leftPhoto = next;
        await save(); await draw();
      } catch (error) { fail(error); }
    });
    $("#left-remove")?.addEventListener("click", async () => {
      const old = step.leftPhoto;
      step.leftPhoto = null;
      await save();
      if (old) await dropPhoto(old);
      await draw();
    });
    const splitLabel = () => {
      const part = stepSplit(step);
      $("#split-label").textContent = MOVES[step.move]
        ? `Previous image ${Math.round(part * 100)}% · This step ${100 - Math.round(part * 100)}%`
        : `Part ${Math.round(part * 100)}% · Photo ${100 - Math.round(part * 100)}%`;
    };
    if ($("#split")) {
      splitLabel();
      $("#split").addEventListener("input", e => {
        const value = Number(e.target.value) / 100;
        if (MOVES[step.move]) step.beforeSplit = value; else step.split = value;
        splitLabel(); refreshPreview();
      });
      $("#split").addEventListener("change", () => save());
      $("#layout-all")?.addEventListener("click", async () => {
        if (!(await confirmDialog("Use this layout for every step?", `All ${build.steps.length} steps get this part/photo split and part labels at ${partNameStyle(step).size} pt${partNameStyle(step).show ? "" : ", without part names"}.`, "Apply to all", false))) return;
        for (const other of build.steps) { other.split = step.split; other.partName = { ...step.partName }; }
        await save();
        toast("Layout applied to all steps.");
      });
    }
    $("#pn-show")?.addEventListener("change", async e => {
      step.partName = { ...step.partName, hideNames: !e.target.checked || undefined };
      await save(); refreshPreview();
    });
    app.querySelectorAll("[data-pn-pos]").forEach(b => b.addEventListener("click", async () => {
      step.partName = { ...step.partName, labelPos: b.dataset.pnPos || undefined };
      app.querySelectorAll("[data-pn-pos]").forEach(x => x.setAttribute("aria-checked", String(x === b)));
      await save(); refreshPreview();
    }));
    app.querySelectorAll("[data-pn-size]").forEach(b => b.addEventListener("click", async () => {
      step.partName = { ...step.partName, size: Number(b.dataset.pnSize) };
      app.querySelectorAll("[data-pn-size]").forEach(x => x.setAttribute("aria-checked", String(x === b)));
      await save(); refreshPreview();
    }));

    app.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", async () => {
      const move = b.dataset.move || null;
      if (!!move === !!MOVES[step.move]) return;   // already this kind of step (old "flip"/"turn" count as "prev")
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
    app.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", async () => {
      const [gone] = step.parts.splice(b.dataset.remove, 1);
      await save();
      if (gone?.pic) await dropPhoto(gone.pic);
      draw();
    }));
    // Edit a part's picture for this slide only; the BOM and the library keep the original.
    app.querySelectorAll("[data-pic-edit]").forEach(b => b.addEventListener("click", async () => {
      const p = step.parts[b.dataset.picEdit], part = library.get(p.id);
      try {
        const source = await (await fetch(part.file)).blob();
        const edited = await editPhoto(source, p.pic?.edits ?? blankEdits(), p.pic?.maskId ? await getImage(p.pic.maskId) : null, { slideAspect: 1 });
        if (!edited) return;
        const old = p.pic;
        const pic = { id: uid(), w: edited.w, h: edited.h, edits: edited.edits, maskId: old?.maskId ?? null };
        if (edited.maskBlob) { pic.maskId = uid(); await putImage(pic.maskId, edited.maskBlob); }
        await putImage(pic.id, edited.blob);
        p.pic = pic;
        await save();
        if (old) { const keep = new Set(photoImageIds(pic)); for (const id of photoImageIds(old)) if (!keep.has(id)) { forgetPhoto(id); await deleteImage(id); } }
        draw();
      } catch (error) { fail(error); }
    }));
    app.querySelectorAll("[data-pic-reset]").forEach(b => b.addEventListener("click", async () => {
      const p = step.parts[b.dataset.picReset];
      const old = p.pic;
      delete p.pic;
      await save();
      if (old) await dropPhoto(old);
      draw();
    }));
    // Up to two "goes onto" parts; tap again to unselect.
    app.querySelectorAll("[data-onto]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.onto, onto = step.onto ?? [];
      step.onto = onto.includes(id) ? onto.filter(x => x !== id) : [...onto, id].slice(-2);
      await save();
      app.querySelectorAll("[data-onto]").forEach(chip => chip.classList.toggle("on", step.onto.includes(chip.dataset.onto)));
    }));
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

  const setPhoto = async (source, file = null) => {
    try {
      const shot = file ? await preparePhoto(file) : await takePhoto(source);
      if (!shot) return;
      const old = step.photo;
      step.photo = await newPhoto(shot, { edit: true, slideAspect: slideAspectOf(step) });
      await save();
      if (old) await dropPhoto(old);
      await draw();
    } catch (error) { fail(error); }
  };

  // Laptop: drop a photo onto the page, or paste one (⌘V / Ctrl+V), to use it for this step.
  dropTarget(step.photo ? "Drop a photo to replace this step's photo" : "Drop a photo for this step", files => setPhoto(null, files[0]));
  onScreen(document, "paste", e => {
    if (e.target.closest?.("textarea, input")) return;
    const [file] = imageFiles(e);
    if (file) { e.preventDefault(); setPhoto(null, file); }
  });

  await draw();
  if (picker) return partPicker({
    build, library, back: here,
    title: "Choose parts",
    subtitle: `Step ${index + 1} · tap a part to add it, tap again for more`,
    count: id => step.parts.find(p => p.id === id)?.qty ?? 0,
    add: id => {
      const chosen = step.parts.find(p => p.id === id);
      if (chosen) chosen.qty = Math.min(99, chosen.qty + 1);
      else if (step.parts.length >= MAX_STEP_PARTS) { toast(`A step can use up to ${MAX_STEP_PARTS} different parts. Remove one first, or add the part in the next step.`); return false; }
      else step.parts.push({ id, qty: 1 });
    },
    remove: id => {
      const chosen = step.parts.find(p => p.id === id);
      if (!chosen) return;
      if (chosen.qty > 1) chosen.qty -= 1;
      else {
        step.parts = step.parts.filter(p => p.id !== id);
        if (chosen.pic) dropPhoto(chosen.pic);
      }
    },
  });
}

/** Distinct parts added in the steps before `index`, most recent first: the "Goes onto" choices. */
function earlierParts(build, index, library, limit = 10) {
  const seen = new Set(), out = [];
  for (let i = index - 1; i >= 0 && out.length < limit; i--) {
    for (const p of build.steps[i].parts) {
      const part = library.get(p.id);
      if (part && !seen.has(p.id)) { seen.add(p.id); out.push(part); }
    }
  }
  return out;
}

async function removeStep(build, step) {
  build.steps = build.steps.filter(s => s.id !== step.id);
  await saveBuild(build);
  if (step.photo) await dropPhoto(step.photo);
  if (step.leftPhoto) await dropPhoto(step.leftPhoto);
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

/** count(id) → how many are chosen now (0 = none); add(id) records one more tap; remove(id) takes one away. */
function partPicker({ build, library, back, title, subtitle, count, add, remove }) {
  const used = new Set(build.steps.flatMap(s => s.parts.map(p => p.id)));
  const all = [...library.values()];
  const kitIds = [...new Set(all.map(p => p.kit))];
  let onlyKit = "";   // with several kits: "" shows all, or one kit's id
  const overlay = document.createElement("div");
  overlay.className = "picker";
  overlay.innerHTML = `
    <header class="bar">
      <a href="${back}" class="icon-btn" aria-label="Close">‹</a>
      <div class="title"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
    </header>
    <div class="search"><input type="search" placeholder="Search ${all.length} parts (e.g. 1 x 4, gear, sensor)" autocomplete="off"></div>
    ${kitIds.length > 1 ? `<div class="kit-filter" role="radiogroup" aria-label="Kit"><button role="radio" aria-checked="true" data-kit="">All kits</button>${kitIds.map(id => `<button role="radio" aria-checked="false" data-kit="${esc(id)}" data-kit-name="${esc(id)}"></button>`).join("")}</div>` : ""}
    <div class="picker-body"></div>
    <footer class="actions"><a class="btn primary wide" href="${back}">Done</a></footer>`;
  document.body.append(overlay);
  app.inert = true;
  const body = overlay.querySelector(".picker-body");
  const search = overlay.querySelector("input");

  // The count badge and the − button; kept apart from the picture so a tap can update them in place.
  const marks = part => {
    const chosen = count(part.id);
    return chosen ? `<b class="badge">${chosen}</b><span class="part-minus" role="button" tabindex="0" data-minus-id="${esc(part.id)}" aria-label="${chosen > 1 ? "One fewer" : "Remove"} ${esc(part.name)}"><i>${chosen > 1 ? "−" : "✕"}</i></span>` : "";
  };
  const tile = part => `<button class="part ${count(part.id) ? "picked" : ""}" data-id="${esc(part.id)}">
      <img src="${esc(part.file)}" alt="" loading="lazy">
      <span>${esc(part.name)}</span>${marks(part)}
    </button>`;
  // After a tap, refresh only that part's tile(s): redrawing the grid would reload every picture.
  const refreshTile = id => {
    const part = library.get(id);
    body.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach(el => {
      el.classList.toggle("picked", !!count(id));
      el.querySelectorAll(".badge, .part-minus").forEach(x => x.remove());
      el.insertAdjacentHTML("beforeend", marks(part));
    });
  };
  const draw = () => {
    const words = searchWords(search.value);
    const match = part => { const hay = searchWords(`${part.name} ${part.kitName}`); return words.every(w => hay.some(h => /^\d/.test(w) ? h === w : h.startsWith(w))); };
    const found = all.filter(p => (!onlyKit || p.kit === onlyKit) && match(p));
    const recent = words.length ? [] : found.filter(p => used.has(p.id));
    body.innerHTML = `
      ${recent.length ? `<h3>Used in this build</h3><div class="grid">${recent.map(tile).join("")}</div><h3>All parts</h3>` : ""}
      ${found.length ? `<div class="grid">${found.map(tile).join("")}</div>` : `<p class="empty">No part matches "${esc(search.value)}".</p>`}`;
  };
  body.addEventListener("click", async e => {
    const minus = e.target.closest("[data-minus-id]");
    if (minus) {
      // One fewer; at 1 the part is removed. Does not also count as a tap on the tile.
      e.stopPropagation();
      const id = minus.dataset.minusId;
      remove(id);
      refreshTile(id);
      await saveBuild(build);
      return;
    }
    const button = e.target.closest("[data-id]");
    if (!button) return;
    const id = button.dataset.id;
    if (add(id) === false) return;
    refreshTile(id);
    await saveBuild(build);
  });
  search.addEventListener("input", draw);
  overlay.querySelectorAll("[data-kit]").forEach(b => b.addEventListener("click", () => {
    onlyKit = b.dataset.kit;
    overlay.querySelectorAll("[data-kit]").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    draw();
  }));
  overlay.querySelectorAll("[data-kit-name]").forEach(async b => { b.textContent = await kitName(b.dataset.kitName); });
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
  screenListeners.forEach(remove => remove());
  screenListeners = [];
  document.body.classList.remove("dropping");
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

// Keyboard: ← / → move between steps, Esc closes the part picker.
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (document.querySelector("dialog[open], .pe")) return;
  if (e.key === "Escape" && document.querySelector(".picker")) { e.preventDefault(); history.back(); return; }
  if (document.querySelector(".picker")) return;
  const link = e.key === "ArrowLeft" ? app.querySelector('a[aria-label="Previous step"]:not(.off)')
    : e.key === "ArrowRight" ? app.querySelector('a[aria-label="Next step"]:not(.off)') : null;
  if (link) { e.preventDefault(); link.click(); }
});

window.addEventListener("hashchange", route);
keepStorage();
route();
