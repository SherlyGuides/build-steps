// Background removal, run off the main thread so the editor stays responsive.
// Model: ISNet (IS-Net, "Highly Accurate Dichotomous Image Segmentation"), AGPL-3.0, the model
// behind IMG.LY's background remover. Downloaded once from Hugging Face, then kept in the
// browser's cache by transformers.js. BiRefNet was tried first and is more accurate, but no
// browser runtime can run it on Apple-class GPUs yet and it runs out of memory on the CPU.

import { AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/ISNet-ONNX";
env.allowLocalModels = false;

let loading = null, loadedWith = "";

function load(device, dtype) {
  const key = `${device}|${dtype}`;
  if (loading && loadedWith !== key) loading = null;
  loadedWith = key;
  loading ??= (async () => {
    const progress = info => {
      if (info.status === "progress" && info.total) self.postMessage({ type: "progress", file: info.file, loaded: info.loaded, total: info.total });
    };
    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained(MODEL_ID, { device, dtype, progress_callback: progress }),
      AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progress }),
    ]);
    return { model, processor };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

self.onmessage = async ({ data }) => {
  const { id, device, dtype, pixels, width, height } = data;
  try {
    const { model, processor } = await load(device, dtype);
    self.postMessage({ type: "status", id, message: "Cutting out the model…" });
    const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 4).rgb();
    const { pixel_values } = await processor(image);
    const outputs = await model({ input: pixel_values });
    const matte = Object.values(outputs)[0][0].mul(255).to("uint8");
    const mask = await RawImage.fromTensor(matte).resize(width, height);
    const alpha = new Uint8Array(width * height);
    for (let i = 0, c = mask.channels; i < alpha.length; i++) alpha[i] = mask.data[i * c];
    self.postMessage({ type: "done", id, alpha, width, height }, [alpha.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", id, message: String(error?.message ?? error) });
  }
};
