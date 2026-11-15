import { zipSync, strToU8 } from "fflate";

/** Smallest valid-enough PDF: one blank page. file-type reads "%PDF-", mupdf renders the page. */
export const tinyPdf = (): Buffer =>
  Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Root 1 0 R/Size 4>>\n%%EOF\n",
  );

export const zipOf = (files: Record<string, string | Uint8Array>): Buffer =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))),
  );

/** ~50 MB of zeros deflates to ~50 KB: a ratio of ~1000:1. */
export const zipBomb = (): Buffer => zipOf({ "big.bin": new Uint8Array(50 * 1024 * 1024) });

/** A Windows executable header wearing a .pdf name. */
export const fakePdfExe = (): Buffer => Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00"), Buffer.alloc(2048, 7)]);
