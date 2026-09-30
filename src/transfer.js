import JSZip from "jszip";
import { getImage, photoImageIds, putImage, saveBuild, uid } from "./db.js";

// A build file is a .zip holding build.json and every step picture (slide photo, original and
// background cut-out, so photos stay editable), so a build can be moved to
// another phone or kept as a backup and reopened later.

const FORMAT = "thinkpro-build-steps";

export function buildFileName(build) {
  const name = build.name.replace(/[^A-Za-z0-9 _-]+/g, "-").trim().slice(0, 80) || "Build";
  const where = build.grade && build.session ? `_G${build.grade}_S${build.session}` : "";
  return `${name}${build.kind === "bom" ? "_materials-list" : ""}${where}_build.zip`;
}

export async function exportBuild(build) {
  const zip = new JSZip();
  zip.file("build.json", JSON.stringify({ format: FORMAT, version: 1, build }, null, 1));
  for (const step of build.steps) {
    for (const photo of [step.photo, step.leftPhoto, ...(step.parts ?? []).map(p => p.pic)]) {
      for (const id of photoImageIds(photo)) {
        const blob = await getImage(id);
        if (blob) zip.file(`photos/${id}${id === photo.maskId ? ".png" : ".jpg"}`, blob);
      }
    }
  }
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}

/** Import a build file as a new build (new ids, so it never overwrites one already on the phone). */
export async function importBuild(file) {
  let zip, data;
  try {
    zip = await JSZip.loadAsync(file);
    data = JSON.parse(await zip.file("build.json").async("string"));
  } catch {
    throw new Error("This is not a build file made by this app.");
  }
  if (data?.format !== FORMAT || !data.build || !Array.isArray(data.build.steps)) throw new Error("This is not a build file made by this app.");
  const source = data.build;
  const steps = [];
  for (const step of source.steps) {
    let photo = null;
    // Each stored picture gets a new id so an imported build never overwrites one on this phone.
    const copy = async (id, type) => {
      const entry = id && zip.file(`photos/${id}${type === "image/png" ? ".png" : ".jpg"}`);
      if (!entry) return null;
      const fresh = uid();
      await putImage(fresh, new Blob([await entry.async("arraybuffer")], { type }));
      return fresh;
    };
    const copyPhoto = async source => {
      const slideId = source && await copy(source.id, "image/jpeg");
      if (!slideId) return null;
      const originalId = source.original && (source.original.id === source.id ? slideId : await copy(source.original.id, "image/jpeg"));
      const out = {
        ...source, id: slideId,
        original: originalId ? { ...source.original, id: originalId } : null,
        maskId: await copy(source.maskId, "image/png"),
      };
      if (!out.maskId && out.edits) out.edits = { ...out.edits, cutout: null };
      return out;
    };
    photo = await copyPhoto(step.photo);
    const parts = [];
    for (const p of Array.isArray(step.parts) ? step.parts : []) {
      const pic = await copyPhoto(p.pic);
      parts.push({ id: String(p.id), qty: Math.max(1, Number(p.qty) || 1), ...(pic ? { pic } : {}) });
    }
    const leftPhoto = await copyPhoto(step.leftPhoto);
    steps.push({
      id: uid(),
      instruction: String(step.instruction ?? ""),
      move: step.move === "flip" || step.move === "turn" ? step.move : null,
      parts,
      onto: Array.isArray(step.onto) ? step.onto.map(String).slice(0, 2) : [],
      split: Number.isFinite(Number(step.split)) ? Number(step.split) : undefined,
      layout: step.layout === "single" ? "single" : undefined,
      partName: step.partName && typeof step.partName === "object" ? { show: !!step.partName.show, size: Number(step.partName.size) || undefined } : undefined,
      photo,
      leftPhoto,
    });
  }
  const build = { ...source, id: uid(), steps, createdAt: Date.now() };
  await saveBuild(build);
  return build;
}
