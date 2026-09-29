// Builds and their pictures live in the app's IndexedDB, so they survive restarts and can be
// reopened later to change a picture or an instruction and generate a new deck.
//   builds: { id, name, grade, session, kit, deckVersion, showPartNames, steps: [...], createdAt, updatedAt }
//   step:   { id, instruction, photo: { id, w, h } | null, parts: [{ id, qty }] }
//   images: Blob keyed by photo id

const DB_NAME = "build-steps";
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("builds", { keyPath: "id" });
      request.result.createObjectStore("images");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage is full or unavailable."));
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const listBuilds = async () =>
  ((await run("builds", "readonly", s => s.getAll())) || []).sort((a, b) => b.updatedAt - a.updatedAt);
export const getBuild = id => run("builds", "readonly", s => s.get(id));
export const saveBuild = build => run("builds", "readwrite", s => s.put({ ...build, updatedAt: Date.now() }));
export const getImage = id => run("images", "readonly", s => s.get(id));
export const putImage = (id, blob) => run("images", "readwrite", s => s.put(blob, id));
export const deleteImage = id => run("images", "readwrite", s => s.delete(id));

export async function deleteBuild(build) {
  for (const step of build.steps) if (step.photo) await deleteImage(step.photo.id);
  await run("builds", "readwrite", s => s.delete(build.id));
}

// Ask the browser not to clear our storage when the phone runs low on space.
export function keepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
