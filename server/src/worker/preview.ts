import { readFile } from "node:fs/promises";
import { putObject } from "../lib/s3";

/** Deterministic keys: a retried job overwrites the same object instead of creating a second one. */
export const previewKeyFor = (versionId: string, ext: "png" | "txt") => `previews/${versionId}.${ext}`;

export async function pdfFirstPage(path: string, versionId: string): Promise<string | null> {
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(await readFile(path), "application/pdf");
    if (doc.countPages() < 1) return null;
    const page = doc.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.scale(1.2, 1.2), mupdf.ColorSpace.DeviceRGB, false, true);
    const key = previewKeyFor(versionId, "png");
    await putObject(key, Buffer.from(pix.asPNG()), "image/png");
    return key;
  } catch {
    return null; // a preview failure must not fail the submission
  }
}

export async function textPreview(text: string, versionId: string): Promise<string> {
  const key = previewKeyFor(versionId, "txt");
  await putObject(key, Buffer.from(text, "utf8"), "text/plain; charset=utf-8");
  return key;
}
