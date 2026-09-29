import JSZip from "jszip";
import { getImage, putImage, saveBuild, uid } from "./db.js";

// A build file is a .zip holding build.json and every step photo, so a build can be moved to
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
    if (!step.photo) continue;
    const blob = await getImage(step.photo.id);
    if (blob) zip.file(`photos/${step.photo.id}.jpg`, blob);
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
    const entry = step.photo && zip.file(`photos/${step.photo.id}.jpg`);
    if (entry) {
      photo = { ...step.photo, id: uid() };
      await putImage(photo.id, new Blob([await entry.async("arraybuffer")], { type: "image/jpeg" }));
    }
    steps.push({
      id: uid(),
      instruction: String(step.instruction ?? ""),
      move: step.move === "flip" || step.move === "turn" ? step.move : null,
      parts: Array.isArray(step.parts) ? step.parts.map(p => ({ id: String(p.id), qty: Math.max(1, Number(p.qty) || 1) })) : [],
      photo,
    });
  }
  const build = { ...source, id: uid(), steps, createdAt: Date.now() };
  await saveBuild(build);
  return build;
}
