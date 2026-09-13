// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  readFileAsBase64,
  prepareImageForUpload,
  totalAttachmentBytes,
  RECOMPRESS_THRESHOLD_BYTES,
} from "./image.js";

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

describe("totalAttachmentBytes", () => {
  it("sums the base64 lengths of the batch", () => {
    expect(
      totalAttachmentBytes([
        { name: "a", base64: "abcd", mediaType: "image/png" },
        { name: "b", base64: "ef", mediaType: "image/jpeg" },
      ]),
    ).toBe(6);
  });

  it("is zero for an empty batch", () => {
    expect(totalAttachmentBytes([])).toBe(0);
  });
});

describe("prepareImageForUpload", () => {
  it("leaves a small image untouched", async () => {
    const file = new File(["tiny"], "small.png", { type: "image/png" });

    const result = await prepareImageForUpload(file);

    expect(result.mediaType).toBe("image/png");
    expect(result.base64).toBe(await readFileAsBase64(file).then((r) => r.base64));
  });

  it("leaves formats that cannot be rasterised untouched even when large", async () => {
    // Animated GIFs and SVGs would lose animation / sharpness on a canvas.
    const big = new Uint8Array(RECOMPRESS_THRESHOLD_BYTES + 1024);
    const file = new File([big], "big.gif", { type: "image/gif" });

    const result = await prepareImageForUpload(file);

    expect(result.mediaType).toBe("image/gif");
  });

  it("falls back to the original when the image cannot be decoded", async () => {
    // jsdom has no createImageBitmap, standing in for any decode failure.
    const big = new Uint8Array(RECOMPRESS_THRESHOLD_BYTES + 1024);
    const file = new File([big], "big.jpg", { type: "image/jpeg" });

    const result = await prepareImageForUpload(file);

    expect(result.mediaType).toBe("image/jpeg");
    expect(result.base64.length).toBeGreaterThan(0);
  });
});
