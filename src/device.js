// Phone features through the browser: taking step photos and saving or sharing decks and
// build files. Works in Safari on iPhone/iPad, Chrome on Android and any desktop browser.

// Originals are kept at up to 2000 px so a photo can be cropped later without going soft.
// The photo on the slide is rendered from the original by the photo editor (1600 px).
const ORIGINAL_SIDE = 2000;

// The input stays in the page until it is used: iOS Safari ignores clicks on detached inputs.
function pickFiles(accept, { capture = false, multiple = false } = {}) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept, multiple, hidden: true });
    if (capture) input.setAttribute("capture", "environment");
    let done = false;
    const finish = files => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    document.body.append(input);
    input.click();
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That picture could not be opened. Try a JPEG or PNG photo."));
    img.src = src;
  });
}

// Browsers apply the photo's EXIF rotation when drawing, so portrait shots stay upright.
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, ORIGINAL_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return { blob, w: canvas.width, h: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** source: "camera" | "gallery". Resolves to the original { blob, w, h } or null when cancelled. */
export async function takePhoto(source) {
  const [file] = await pickFiles("image/*", { capture: source === "camera" });
  return file ? shrink(file) : null;
}

/** Several photos from the gallery, in the order they were selected. Call straight from a tap. */
export function pickGalleryPhotos() {
  return pickFiles("image/*", { multiple: true });
}

export { shrink as preparePhoto };

export async function pickBuildFile() {
  const [file] = await pickFiles(".zip,application/zip");
  return file ?? null;
}

const MIME = { pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip" };

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Phones and tablets get the share sheet (Save to Files, WhatsApp, Drive, email…).
const isTouch = () => matchMedia("(pointer: coarse)").matches;

/** Offer a finished file to the user. Returns a sentence saying what happened. */
export async function saveAndShare(blob, fileName, title) {
  const type = MIME[fileName.split(".").pop()] ?? blob.type;
  const file = new File([blob], fileName, { type });
  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return `${fileName} is ready.`;
    } catch (error) {
      if (error?.name === "AbortError") return `${fileName} was not shared. Tap the button again to save it.`;
      // Some browsers refuse this file type: fall through to a normal download.
    }
  }
  download(file, fileName);
  return `${fileName} downloaded.`;
}
