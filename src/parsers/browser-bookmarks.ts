// Netscape HTML bookmark parser. Handles Chrome, Brave, Firefox, Safari exports.
// Uses cheerio for lenient HTML parsing.
import { load as cheerioLoad } from "cheerio";
import type { RawBookmark } from "../types.js";

export function isNetscapeBookmarksFile(content: string): boolean {
  // Tolerant check — DOCTYPE might be on first or second line, missing entirely on
  // some Safari exports. Look in the first ~500 chars.
  const head = content.slice(0, 500).toLowerCase();
  return head.includes("netscape-bookmark-file") || head.includes("<dl><p>");
}

export function parseBookmarksHtml(content: string, sourceFile: string): RawBookmark[] {
  const $ = cheerioLoad(content, { xml: false });
  const bookmarks: RawBookmark[] = [];

  // Walk: descend through <DL><DT><H3>...</H3><DL>... for folders,
  // collect <DT><A> as bookmarks with accumulated folder path.
  // cheerio doesn't give us easy ancestor-folder walking, so we do it manually.
  const rootDL = $("dl").first();
  if (rootDL.length === 0) return bookmarks;

  walk(rootDL, [], $, bookmarks, sourceFile);
  return bookmarks;
}

function walk(
  $dl: any,
  folderStack: string[],
  $: any,
  out: RawBookmark[],
  sourceFile: string
): void {
  // Direct <dt> children of this <dl>
  // (cheerio doesn't enforce DT/DD structure; we walk children loosely)
  $dl.children().each((_: number, el: any) => {
    const tag = el.tagName?.toLowerCase();
    if (tag !== "dt") return;

    const $dt = $(el);
    const $folderHeader = $dt.children("h3").first();
    if ($folderHeader.length > 0) {
      const folderName = $folderHeader.text().trim();
      // The folder's <DL> is the next sibling of the <DT> in Netscape format,
      // but in DOM terms cheerio nests it inside <DT>. Look both places.
      let $childDL = $dt.children("dl").first();
      if ($childDL.length === 0) {
        $childDL = $dt.next("dl").first();
      }
      if ($childDL.length > 0) {
        walk($childDL, [...folderStack, folderName], $, out, sourceFile);
      }
      return;
    }
    const $a = $dt.children("a").first();
    if ($a.length > 0) {
      const href = $a.attr("href");
      if (!href) return; // → caller logs as error
      const addDate = parseInt($a.attr("add_date") ?? "0", 10);
      const title = $a.text().trim();
      out.push({
        url: href,
        title: title || null,
        save_date: addDate > 0 ? addDate * 1000 : Date.now(),
        save_date_is_inferred: addDate === 0,
        bookmark_folder_path: folderStack.join("|"),
        user_notes: null,
        source_export_file: sourceFile,
      });
    }
  });
}
