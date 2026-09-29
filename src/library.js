// Parts pictures and names bundled with the app, one folder per kit (public/library/<kit>/).
// Snapshot of the BOM maker's library on glbadmin.thinkpro.academy. To add a kit
// (Innovator, Computational, Tronix), add its folder and parts.json and list it in kits.json.

let kits;
const partsByKit = new Map();

export async function loadKits() {
  kits ??= (await (await fetch("library/kits.json")).json()).kits;
  return kits;
}

export async function loadParts(kitId) {
  if (!partsByKit.has(kitId)) {
    const kit = (await loadKits()).find(k => k.id === kitId);
    if (!kit) throw new Error(`The parts library "${kitId}" is not in this app.`);
    const data = await (await fetch(kit.parts)).json();
    partsByKit.set(kitId, new Map(data.parts.map(p => [p.id, p])));
  }
  return partsByKit.get(kitId);
}

export async function kitName(kitId) {
  return (await loadKits()).find(k => k.id === kitId)?.name ?? kitId;
}
