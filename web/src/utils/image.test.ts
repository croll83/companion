// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, prepareImageFile, readAttachments, readFileAsBase64, scaledSize, type ImageCodec } from "./image.js";

describe("readFileAsBase64", () => {
  it("reads a text file and returns base64 + mediaType", async () => {
    // Create a Blob-backed File with known content
    const content = "hello world";
    const file = new File([content], "test.txt", { type: "text/plain" });

    const result = await readFileAsBase64(file);

    // The base64 of "hello world" is "aGVsbG8gd29ybGQ="
    expect(result.base64).toBe("aGVsbG8gd29ybGQ=");
    expect(result.mediaType).toBe("text/plain");
  });

  it("reads an image file and returns correct mediaType", async () => {
    // Create a minimal 1x1 PNG file (valid PNG header)
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
    ]);
    const file = new File([pngBytes], "pixel.png", { type: "image/png" });

    const result = await readFileAsBase64(file);

    expect(result.mediaType).toBe("image/png");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
  });
});

/**
 * A fake codec (jsdom has no canvas): decode reports the given size, encode
 * returns a blob whose size comes from `sizeOf` (bytes for a given output),
 * and both record their calls.
 */
function fakeCodec(width: number, height: number, sizeOf: (w: number, h: number, type: string, q: number) => number = () => 500_000) {
  const encoded: { w: number; h: number; type: string; q: number }[] = [];
  const close = vi.fn();
  const codec: ImageCodec = {
    decode: vi.fn(async () => ({ width, height, source: {} as CanvasImageSource, close })),
    encode: vi.fn(async (_img, w, h, type, q) => {
      encoded.push({ w, h, type, q });
      return new Blob([new Uint8Array(sizeOf(w, h, type, q))], { type });
    }),
  };
  return { codec, encoded, close };
}

const photo = (bytes: number, type = "image/jpeg", name = "IMG_1234.jpg") => new File([new Uint8Array(bytes)], name, { type });

// Phone photos (9-12 MB, 4000+ px) broke the session: they are scaled to
// MAX_IMAGE_EDGE and re-encoded under MAX_IMAGE_BYTES before they are sent.
describe("prepareImageFile", () => {
  it("keeps the aspect ratio and never enlarges", () => {
    expect(scaledSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(scaledSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(scaledSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it("scales a large phone photo down to a JPEG under the limit", async () => {
    const { codec, encoded, close } = fakeCodec(4032, 3024);
    const out = await prepareImageFile(photo(11_000_000), codec);
    expect(encoded).toEqual([{ w: MAX_IMAGE_EDGE, h: 1536, type: "image/jpeg", q: 0.85 }]);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_1234.jpg");
    expect(out.size).toBe(500_000);
    expect(close).toHaveBeenCalled();
  });

  it("leaves a small image in a supported format untouched", async () => {
    const { codec, encoded } = fakeCodec(1200, 900);
    const file = photo(400_000);
    expect(await prepareImageFile(file, codec)).toBe(file);
    expect(encoded).toHaveLength(0);
  });

  it("re-encodes a small but heavy image, and lowers quality and size until it fits", async () => {
    // Too heavy at 0.85 and 0.7 full size; fits at 0.7 and 3/4 size.
    const { codec, encoded } = fakeCodec(1800, 1200, (w, _h, _t, q) => (q >= 0.7 && w > 1500 ? MAX_IMAGE_BYTES + 1 : 1_000_000));
    const out = await prepareImageFile(photo(6_000_000), codec);
    expect(encoded.map((e) => [e.w, e.q])).toEqual([[1800, 0.85], [1800, 0.7], [1350, 0.7]]);
    expect(out.size).toBe(1_000_000);
  });

  it("keeps a large screenshot PNG, and falls back to JPEG only when the PNG is too heavy", async () => {
    const small = fakeCodec(3000, 2000);
    const png = await prepareImageFile(photo(2_000_000, "image/png", "shot.png"), small.codec);
    expect(png.type).toBe("image/png");
    expect(png.name).toBe("shot.png");
    const heavy = fakeCodec(3000, 2000, (_w, _h, type) => (type === "image/png" ? MAX_IMAGE_BYTES + 1 : 800_000));
    const jpg = await prepareImageFile(photo(2_000_000, "image/png", "shot.png"), heavy.codec);
    expect(heavy.encoded.map((e) => e.type)).toEqual(["image/png", "image/jpeg"]);
    expect(jpg.name).toBe("shot.jpg");
  });

  it("turns a format the models do not take into JPEG", async () => {
    const { codec } = fakeCodec(1000, 800);
    const out = await prepareImageFile(photo(900_000, "image/heic", "IMG_9.HEIC"), codec);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_9.jpg");
  });

  it("leaves GIF, SVG, non-images and undecodable images as they are", async () => {
    const { codec } = fakeCodec(5000, 5000);
    for (const f of [photo(9_000_000, "image/gif", "a.gif"), photo(10, "image/svg+xml", "a.svg"), photo(10, "application/pdf", "a.pdf")]) {
      expect(await prepareImageFile(f, codec)).toBe(f);
    }
    expect(codec.decode).not.toHaveBeenCalled();
    const broken: ImageCodec = { decode: async () => { throw new Error("no"); }, encode: vi.fn() };
    const f = photo(9_000_000);
    expect(await prepareImageFile(f, broken)).toBe(f);
  });

  it("sends the original when encoding fails", async () => {
    const close = vi.fn();
    const failing: ImageCodec = {
      decode: async () => ({ width: 4000, height: 3000, source: {} as CanvasImageSource, close }),
      encode: async () => { throw new Error("canvas"); },
    };
    const f = photo(9_000_000);
    expect(await prepareImageFile(f, failing)).toBe(f);
    expect(close).toHaveBeenCalled();
  });
});

describe("readAttachments", () => {
  it("prepares images, keeps PDFs only when allowed, skips other files, names pasted ones", async () => {
    const { codec } = fakeCodec(4000, 3000);
    const files = [
      photo(10_000_000),
      new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
      new File(["x"], "notes.txt", { type: "text/plain" }),
      new File([new Uint8Array(10)], "", { type: "image/png" }),
    ];
    const withPdf = await readAttachments(files, { pdf: true, codec, fallbackName: () => "pasted-1.png" });
    expect(withPdf.map((a) => [a.name, a.mediaType])).toEqual([["IMG_1234.jpg", "image/jpeg"], ["doc.pdf", "application/pdf"], ["pasted-1.png", "image/png"]]);
    expect(withPdf[0].base64.length).toBeGreaterThan(600_000);
    const noPdf = await readAttachments(files.slice(1, 3), { codec });
    expect(noPdf).toEqual([]);
  });
});

