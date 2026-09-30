import JSZip from "jszip";
import { getImage, photoImageIds, putImage, saveBuild, uid } from "./db.js";

// A build file is a .zip holding build.json and every step picture (slide photo, original and
// background cut-out, so photos stay editable), so a build can be moved to
// another phone or kept as a backup and reopened later.

const FORMAT = "thinkpro-build-steps";

export function buildFileName(build) {
  const name = build.name.replace(/[^A-Za-z0-9 _-]+/g, "-").trim().slice(0, 80) || "Build";
  return `${name}_G${build.grade}_S${build.session}_build.zip`;
}

export async function exportBuild(build) {
  const zip = new JSZip();
  zip.file("build.json", JSON.stringify({ format: FORMAT, version: 1, build }, null, 1));
  for (const step of build.steps) {
    for (const id of photoImageIds(step.photo)) {
      const blob = await getImage(id);
      if (blob) zip.file(`photos/${id}${id === step.photo.maskId ? ".png" : ".jpg"}`, blob);
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
    const slideId = step.photo && await copy(step.photo.id, "image/jpeg");
    if (slideId) {
      const originalId = step.photo.original && (step.photo.original.id === step.photo.id ? slideId : await copy(step.photo.original.id, "image/jpeg"));
      photo = {
        ...step.photo, id: slideId,
        original: originalId ? { ...step.photo.original, id: originalId } : null,
        maskId: await copy(step.photo.maskId, "image/png"),
      };
      if (!photo.maskId && photo.edits) photo.edits = { ...photo.edits, cutout: null };
    }
    steps.push({
      id: uid(),
      instruction: String(step.instruction ?? ""),
      move: step.move === "flip" || step.move === "turn" ? step.move : null,
      parts: Array.isArray(step.parts) ? step.parts.map(p => ({ id: String(p.id), qty: Math.max(1, Number(p.qty) || 1) })) : [],
      onto: Array.isArray(step.onto) ? step.onto.map(String).slice(0, 2) : [],
      split: Number.isFinite(Number(step.split)) ? Number(step.split) : undefined,
      partName: step.partName && typeof step.partName === "object" ? { show: !!step.partName.show, size: Number(step.partName.size) || undefined } : undefined,
      photo,
    });
  }
  const build = { ...source, id: uid(), steps, createdAt: Date.now() };
  await saveBuild(build);
  return build;
}
