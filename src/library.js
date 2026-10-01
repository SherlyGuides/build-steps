// Parts pictures and names bundled with the app, one folder per kit (public/library/<kit>/).
// Xplorer is a snapshot of the BOM maker's library on glbadmin.thinkpro.academy; PeeCee comes from
// the kit photos supplied for it. To add a kit
// (Innovator, Tronix), add its folder and parts.json and list it in kits.json.

let kits;
const partsByKit = new Map();

export async function loadKits() {
  kits ??= (await (await fetch("library/kits.json")).json()).kits;
  return kits;
}

/** The kits a build uses: build.kits, or the single build.kit of builds made before more were allowed. */
export const kitsOf = build => build?.kits?.length ? build.kits : [build?.kit ?? "xplorer"];

async function loadKit(kitId) {
  if (!partsByKit.has(kitId)) {
    const kit = (await loadKits()).find(k => k.id === kitId);
    if (!kit) throw new Error(`The parts library "${kitId}" is not in this app.`);
    const data = await (await fetch(kit.parts)).json();
    partsByKit.set(kitId, new Map(data.parts.map(p => [p.id, { ...p, kit: kitId }])));
  }
  return partsByKit.get(kitId);
}

/** Parts of one kit or several (part ids are unique across kits), as one Map by id; each part knows its kit. */
export async function loadParts(kitIds) {
  const maps = await Promise.all([].concat(kitIds).map(loadKit));
  return maps.length === 1 ? maps[0] : new Map(maps.flatMap(m => [...m]));
}

export async function kitName(kitIds) {
  const kits = await loadKits();
  return [].concat(kitIds).map(id => kits.find(k => k.id === id)?.name ?? id).join(" + ");
}
