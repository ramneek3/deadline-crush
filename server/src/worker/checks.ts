import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { lookup } from "node:dns/promises";
import net from "node:net";
import yauzl from "yauzl";
import { fileTypeFromFile } from "file-type";
import { config } from "../config";
import { getObjectStream } from "../lib/s3";

export const ALLOWED_TYPES = new Set(["application/pdf", "application/zip"]);

/** Stream the object to disk (the worker may stream; the API never does), hashing as we go. */
export async function downloadToFile(key: string, dest: string, maxBytes: number) {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new Error("file_too_large"));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(await getObjectStream(key), meter, createWriteStream(dest));
  return { sha256: hash.digest("hex"), bytes };
}

/** Type is decided from the bytes (magic numbers), never from the file name. */
export async function detectType(path: string): Promise<{ mime: string | null; ext: string | null }> {
  const t = await fileTypeFromFile(path);
  return { mime: t?.mime ?? null, ext: t?.ext ?? null };
}

export interface ArchiveReport {
  ok: boolean;
  problems: string[];
  entries: number;
  uncompressedBytes: number;
  readme?: { name: string; text: string };
}

/** yauzl itself refuses "../" and absolute entry names; report that as an unsafe path, not as corruption. */
const classify = (e: unknown) => (/invalid relative path|absolute path/i.test((e as Error)?.message ?? "") ? "unsafe_path_in_archive" : "corrupt_archive");

const NESTED = /\.(zip|jar|gz|tgz|bz2|xz|7z|rar|tar)$/i;
const README = /(^|\/)readme(\.(md|txt|markdown))?$/i;
const README_MAX = 64 * 1024;

/**
 * Inspect a zip's central directory WITHOUT extracting it. Declared sizes can be forged, so
 * anything we do read is capped by actual bytes, not by what the archive claims.
 */
export function inspectZip(path: string): Promise<ArchiveReport> {
  const { maxEntries, maxUncompressedBytes, maxRatio } = config.worker;
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return resolve({ ok: false, problems: [classify(err)], entries: 0, uncompressedBytes: 0 });
      const report: ArchiveReport = { ok: true, problems: [], entries: 0, uncompressedBytes: 0 };
      const add = (p: string) => !report.problems.includes(p) && report.problems.push(p);
      let compressedTotal = 0;
      let readmeEntry: yauzl.Entry | null = null;

      const finish = async () => {
        report.ok = report.problems.length === 0;
        const overall = compressedTotal > 0 ? report.uncompressedBytes / compressedTotal : 1;
        if (overall > maxRatio) {
          add(`zip_bomb: overall compression ratio ${Math.round(overall)}:1 exceeds ${maxRatio}:1`);
          report.ok = false;
        }
        if (readmeEntry && report.ok) {
          try {
            report.readme = { name: readmeEntry.fileName, text: await readCapped(zip, readmeEntry, README_MAX) };
          } catch {
            /* preview is best-effort */
          }
        }
        zip.close();
        resolve(report);
      };

      zip.on("error", (e: Error) => {
        zip.close();
        resolve({ ok: false, problems: [classify(e)], entries: report.entries, uncompressedBytes: report.uncompressedBytes });
      });
      zip.on("end", finish);
      zip.on("entry", (e: yauzl.Entry) => {
        report.entries++;
        report.uncompressedBytes += e.uncompressedSize;
        compressedTotal += e.compressedSize;
        if (report.entries > maxEntries) {
          add(`too_many_entries: more than ${maxEntries} files`);
          return finishEarly();
        }
        if (report.uncompressedBytes > maxUncompressedBytes) {
          add(`archive_too_large: expands beyond ${Math.round(maxUncompressedBytes / 1048576)} MB`);
          return finishEarly();
        }
        if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > maxRatio && e.uncompressedSize > 1024 * 1024) {
          add(`zip_bomb: entry "${e.fileName.slice(0, 80)}" compresses ${Math.round(e.uncompressedSize / e.compressedSize)}:1`);
        }
        if (e.fileName.includes("..") || e.fileName.startsWith("/") || /^[a-zA-Z]:/.test(e.fileName)) add("unsafe_path_in_archive");
        if (NESTED.test(e.fileName)) add("nested_archive_not_allowed");
        if (!readmeEntry && README.test(e.fileName) && !e.fileName.endsWith("/")) readmeEntry = e;
        zip.readEntry();
      });
      const finishEarly = () => {
        zip.close();
        report.ok = false;
        resolve(report);
      };
      zip.readEntry();
    });
  });
}

function readCapped(zip: yauzl.ZipFile, entry: yauzl.Entry, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err);
      const chunks: Buffer[] = [];
      let n = 0;
      stream.on("data", (c: Buffer) => {
        n += c.length;
        if (n > cap) {
          stream.destroy();
          chunks.push(c.subarray(0, c.length - (n - cap)));
          return resolve(Buffer.concat(chunks).toString("utf8"));
        }
        chunks.push(c);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });
  });
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export interface LinkResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** Check that a submitted link responds. Refuses internal addresses (SSRF) and caps redirects. */
export async function checkLink(url: string): Promise<LinkResult> {
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      if (!/^https?:$/.test(current.protocol)) return { url, ok: false, error: "unsupported_protocol" };
      if (process.env.ALLOW_PRIVATE_LINKS !== "true") {
        const addrs = await lookup(current.hostname, { all: true });
        if (addrs.some((a) => isPrivateIp(a.address))) return { url, ok: false, error: "blocked_private_address" };
      }
      const ctl = AbortSignal.timeout(config.worker.linkTimeoutMs);
      let res = await fetch(current, { method: "HEAD", redirect: "manual", signal: ctl });
      if (res.status === 405 || res.status === 501 || res.status === 403) {
        res = await fetch(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(config.worker.linkTimeoutMs), headers: { Range: "bytes=0-0" } });
        res.body?.cancel().catch(() => undefined);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location")!, current);
        continue;
      }
      return { url, ok: res.status >= 200 && res.status < 300, status: res.status, ...(res.ok ? {} : { error: `http_${res.status}` }) };
    }
    return { url, ok: false, error: "too_many_redirects" };
  } catch (e) {
    const name = (e as Error).name;
    return { url, ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
}
