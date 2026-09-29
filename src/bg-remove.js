// Background removal for step photos, using ISNet in a worker (see bg-worker.js).
// Phones whose browser has a GPU with 16-bit support (WebGPU + shader-f16) use the 84 MB model
// on the GPU (under a second). Others use the 42 MB 8-bit model on the CPU (20–40 s on a phone).
// If the GPU fails on a phone, it switches to the CPU and remembers that.

const MODEL_FILES = { fp16: "model_fp16.onnx", q8: "model_quantized.onnx" };
const MODEL_MB = { fp16: 84, q8: 42 };
const MODEL_URL = file => `https://huggingface.co/onnx-community/ISNet-ONNX/resolve/main/onnx/${file}`;
export const MASK_SIDE = 1024; // the model works at 1024 × 1024
const CPU_ONLY_KEY = "build-steps:bg-cpu-only";
const CPU = { device: "wasm", dtype: "q8", sizeMB: MODEL_MB.q8, gpu: false };

let backendPromise;
/** { device, dtype, sizeMB, gpu } for this phone. */
export function backend() {
  backendPromise ??= (async () => {
    try {
      if (localStorage.getItem(CPU_ONLY_KEY)) return CPU;
    } catch { /* storage blocked */ }
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter?.features.has("shader-f16")) return { device: "webgpu", dtype: "fp16", sizeMB: MODEL_MB.fp16, gpu: true };
    } catch { /* no usable GPU */ }
    return CPU;
  })();
  return backendPromise;
}

function useCpuFromNowOn() {
  try { localStorage.setItem(CPU_ONLY_KEY, "1"); } catch { /* storage blocked */ }
  backendPromise = Promise.resolve(CPU);
}

/** True when the model is already on this phone, so no download is needed. */
export async function modelDownloaded() {
  try {
    const { dtype } = await backend();
    const cache = await caches.open("transformers-cache");
    return !!(await cache.match(MODEL_URL(MODEL_FILES[dtype])));
  } catch {
    return false;
  }
}

let worker, nextId = 1;
const waiting = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./bg-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") { for (const job of waiting.values()) job.onStatus?.({ download: data.loaded / data.total, file: data.file }); return; }
      const job = waiting.get(data.id);
      if (!job) return;
      if (data.type === "status") job.onStatus?.({ message: data.message });
      else {
        waiting.delete(data.id);
        if (data.type === "done") job.resolve(data);
        else job.reject(new Error(data.message));
      }
    };
    worker.onerror = event => {
      for (const job of waiting.values()) job.reject(new Error(event.message || "Background removal stopped. The phone may be low on memory."));
      waiting.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

/**
 * Work out the cut-out for a picture. Returns a canvas (at most 1024 px, same shape as the
 * picture) whose alpha channel is the model's matte: 255 = keep, 0 = background.
 * onStatus({ download }) reports the one-time download, onStatus({ message }) the work.
 */
export async function findSubject(img, onStatus) {
  const where = await backend();
  try {
    return await runModel(img, where, onStatus);
  } catch (error) {
    if (!where.gpu) throw error;
    // The GPU could not run it on this phone: use the CPU model instead, now and next time.
    useCpuFromNowOn();
    onStatus?.({ message: "The GPU could not do this, so the phone's processor is used instead (slower)." });
    return runModel(img, CPU, onStatus);
  }
}

async function runModel(img, { device, dtype }, onStatus) {
  const scale = Math.min(1, MASK_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.round(img.naturalWidth * scale), height = Math.round(img.naturalHeight * scale);
  const source = Object.assign(document.createElement("canvas"), { width, height });
  const sctx = source.getContext("2d");
  sctx.drawImage(img, 0, 0, width, height);
  const pixels = sctx.getImageData(0, 0, width, height).data.buffer;

  const id = nextId++;
  const result = await new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onStatus });
    getWorker().postMessage({ id, device, dtype, pixels, width, height }, [pixels]);
  });

  const mask = Object.assign(document.createElement("canvas"), { width, height });
  const mctx = mask.getContext("2d");
  const image = mctx.createImageData(width, height);
  for (let i = 0; i < result.alpha.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = result.alpha[i];
  }
  mctx.putImageData(image, 0, 0);
  return mask;
}
