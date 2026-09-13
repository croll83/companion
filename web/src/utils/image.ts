export interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

/** Longest edge, in pixels, an oversized attachment is scaled down to. */
export const MAX_IMAGE_DIMENSION = 1600;
/** JPEG quality used when re-encoding a downscaled attachment. */
export const IMAGE_QUALITY = 0.8;
/** Attachments at or below this size are uploaded untouched. */
export const RECOMPRESS_THRESHOLD_BYTES = 512 * 1024;
/**
 * Ceiling for the combined base64 payload of a single message. Images travel
 * inline in the `user_message` WebSocket frame, so the whole batch has to fit
 * under the server's `maxPayloadLength` (see web/server/index.ts) with room to
 * spare for the rest of the JSON.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Formats we can rasterise to a canvas without losing anything (no SVG, no animated GIF). */
const RECOMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp"]);

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

/** base64 is ASCII, so one character is one byte on the wire. */
export function totalAttachmentBytes(images: ImageAttachment[]): number {
  return images.reduce((sum, img) => sum + img.base64.length, 0);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * Downscale and re-encode an attachment so a handful of camera photos still fit
 * in one message. A 12MP JPEG off a phone is ~4 MB, which base64 inflates to
 * ~5.5 MB; six of those blow past any sane frame limit and the send silently
 * fails. Models downsample large images anyway, so shrinking here costs no
 * fidelity and saves both bandwidth and tokens.
 *
 * Falls back to the untouched original whenever re-encoding would not help or
 * is not safe (unsupported format, decode failure, result bigger than input).
 */
export async function prepareImageForUpload(file: File): Promise<{ base64: string; mediaType: string }> {
  if (!RECOMPRESSIBLE.has(file.type) || file.size <= RECOMPRESS_THRESHOLD_BYTES) {
    return readFileAsBase64(file);
  }

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return await readFileAsBase64(file);
    // JPEG has no alpha channel: flatten onto white so transparent PNGs don't
    // come out with a black background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas, IMAGE_QUALITY);
    if (!blob || blob.size >= file.size) return await readFileAsBase64(file);
    return { base64: await blobToBase64(blob), mediaType: "image/jpeg" };
  } catch {
    return readFileAsBase64(file);
  } finally {
    bitmap?.close();
  }
}
