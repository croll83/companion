export interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

export function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Downscaling before sending ──────────────────────────────────────────────
//
// A phone photo is 9-12 MB and 4000+ px on its long side. Sent as is, two or
// three of them broke the session: the models cap an image at 5 MB (base64)
// and scale anything beyond about 1.5k px down anyway, so the extra pixels
// only cost bytes. Each image is decoded in the browser when it is picked or
// pasted, scaled to MAX_IMAGE_EDGE on its long side if larger, and re-encoded
// until it fits MAX_IMAGE_BYTES; a format the models do not take (HEIC, BMP,
// TIFF) becomes JPEG. GIF (animation) and SVG go untouched, and so does an
// image the browser cannot decode.

/** Longest side sent, in pixels. */
export const MAX_IMAGE_EDGE = 2048;
/** Largest image sent, in bytes (its base64 stays under the models' 5 MB). */
export const MAX_IMAGE_BYTES = 3_500_000;

const UNTOUCHED = new Set(["image/gif", "image/svg+xml"]);
/** Image types both backends take inline. */
const MODEL_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?: () => void;
}

/** Decoding and encoding, injected in tests (jsdom has no canvas). */
export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, type: string, quality: number): Promise<Blob>;
}

/** The size that fits `max` on the long side, keeping the aspect ratio (never larger). */
export function scaledSize(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

function decodeWithImageElement(file: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser cannot decode this image"));
    };
    img.src = url;
  });
}

/* v8 ignore start -- needs a real canvas; the logic around it is tested with a fake codec */
export const browserCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap === "function") {
      // from-image: a phone photo's EXIF rotation is applied, so it is not sent sideways.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
    }
    return decodeWithImageElement(file);
  },
  async encode(image, width, height, type, quality) {
    const draw = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      if (type === "image/jpeg") {
        ctx.fillStyle = "#fff"; // JPEG has no transparency: white, not black, behind it
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image.source, 0, 0, width, height);
    };
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D canvas");
      draw(ctx);
      return canvas.convertToBlob({ type, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    draw(ctx);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), type, quality));
  },
};
/* v8 ignore stop */

function renamed(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return `${base || "image"}.${ext}`;
}

/**
 * The image as it should be sent: the same file when it is already small
 * enough and in a format the models take, else a scaled and re-encoded copy.
 */
export async function prepareImageFile(file: File, codec: ImageCodec = browserCodec): Promise<File> {
  if (!file.type.startsWith("image/") || UNTOUCHED.has(file.type)) return file;
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    return file; // the server and the model decide; nothing better to do here
  }
  try {
    const tooLarge = Math.max(image.width, image.height) > MAX_IMAGE_EDGE;
    const tooHeavy = file.size > MAX_IMAGE_BYTES;
    if (!tooLarge && !tooHeavy && MODEL_TYPES.has(file.type)) return file;
    const size = scaledSize(image.width, image.height, MAX_IMAGE_EDGE);
    // A screenshot stays PNG (sharp text) unless that is what makes it heavy.
    const first = file.type === "image/png" && !tooHeavy ? "image/png" : "image/jpeg";
    const attempts: { type: string; quality: number; scale: number }[] = [
      { type: first, quality: 0.85, scale: 1 },
      ...(first === "image/png" ? [{ type: "image/jpeg", quality: 0.85, scale: 1 }] : []),
      { type: "image/jpeg", quality: 0.7, scale: 1 },
      { type: "image/jpeg", quality: 0.7, scale: 0.75 },
      { type: "image/jpeg", quality: 0.6, scale: 0.5 },
    ];
    let blob: Blob | null = null;
    let type = first;
    for (const a of attempts) {
      const w = Math.max(1, Math.round(size.width * a.scale));
      const h = Math.max(1, Math.round(size.height * a.scale));
      blob = await codec.encode(image, w, h, a.type, a.quality);
      type = a.type;
      if (blob.size <= MAX_IMAGE_BYTES) break;
    }
    if (!blob) return file;
    return new File([blob], renamed(file.name, type), { type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    image.close?.();
  }
}

/**
 * Read picked or pasted files into attachments: images prepared first
 * (scaled down when needed), PDFs as they are when `pdf` is allowed, other
 * files skipped. `fallbackName` names a pasted file that has none.
 */
export async function readAttachments(
  files: File[],
  opts: { pdf?: boolean; fallbackName?: (file: File) => string; codec?: ImageCodec } = {},
): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const original of files) {
    const isPdf = original.type === "application/pdf";
    if (!original.type.startsWith("image/") && !(isPdf && opts.pdf)) continue;
    const named = original.name ? original : new File([original], opts.fallbackName?.(original) ?? "image", { type: original.type });
    const file = isPdf ? named : await prepareImageFile(named, opts.codec);
    const { base64, mediaType } = await readFileAsBase64(file);
    out.push({ name: file.name, base64, mediaType });
  }
  return out;
}
