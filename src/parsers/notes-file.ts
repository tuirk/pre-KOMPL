// Notes-file URL extraction.
// Pre-kompl treats anything text-ish but not a recognized bookmarks/twitter export as a notes file.
// We regex out URLs and ignore the surrounding structure (markdown links, prose, HTML tags).
import type { RawBookmark } from "../types.js";

// http(s) + path, terminate at whitespace/quote/angle/closing-paren/closing-bracket.
// Trailing punctuation stripped after match.
const URL_RX = /https?:\/\/[^\s"'<>)\]]+/g;
const TRAILING_PUNCT = /[.,;:!?'")\]>—–-]+$/;

export function extractUrlsFromText(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(URL_RX)) {
    let u = match[0].replace(TRAILING_PUNCT, "");
    // Edge: trailing > from "<https://...>" angle wrapper got stripped by regex termination,
    // but a markdown closer like "](" might leave a "]" that we want gone.
    u = u.replace(/[\]\)]+$/, "");
    if (u.length < 8) continue; // "http://x" minimum sanity
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// Heuristic binary-file detection. Don't ingest screenshots as notes files.
// Two-pronged: (1) magic bytes for common formats (PNG, JPEG, GIF, PDF, ZIP/docx/xlsx,
// ELF, Mach-O, MP4, WebP, etc.), (2) entropy fallback for unknown formats.
export function looksLikeBinary(buf: Buffer): boolean {
  // Magic-byte check first — catches small files where entropy is unreliable.
  if (buf.length >= 4) {
    const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
    // PNG: 89 50 4E 47
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return true;
    // JPEG: FF D8 FF
    if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return true;
    // GIF: 47 49 46 38
    if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return true;
    // PDF: 25 50 44 46
    if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return true;
    // ZIP / .docx / .xlsx / .epub: 50 4B 03 04 (or PK\005\006 for empty zip)
    if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return true;
    // ELF: 7F 45 4C 46
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
    // WebP / RIFF: 52 49 46 46
    if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return true;
    // MP4 / MOV: byte 4..7 is "ftyp"
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
    // SQLite: "SQLite format 3"
    if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69) return true;
    // gzip: 1F 8B
    if (b0 === 0x1f && b1 === 0x8b) return true;
  }

  // Entropy fallback for unknown formats.
  const sample = buf.subarray(0, 4096);
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b <= 126) continue;
    if (b >= 128) continue;
    nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

// Try UTF-8, then latin-1, then cp1252. Return null if all yield garbage.
export function decodeText(buf: Buffer): string | null {
  if (looksLikeBinary(buf)) return null;
  try {
    return buf.toString("utf-8");
  } catch {
    // Buffer.toString never throws but defensive.
    try { return buf.toString("latin1"); } catch { return null; }
  }
}

export function urlsToRawBookmarks(
  urls: string[],
  sourceFile: string,
  ingestTime: number
): RawBookmark[] {
  return urls.map((u) => ({
    url: u,
    title: null, // we don't extract titles from notes files (spec decision)
    save_date: ingestTime,
    save_date_is_inferred: true,
    bookmark_folder_path: "",
    user_notes: null,
    source_export_file: sourceFile,
  }));
}
