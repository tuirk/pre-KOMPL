// Re-runs pure-logic predicates against existing Instances in the DB.
// No network calls — only re-evaluates rules against data already in source_payload_json.
//
// This is the escape hatch for the dedup-skip optimization in orchestrator.ts:
// when ingest runs, it short-circuits any Instance already present in the seen-set
// to avoid re-burning API credits. That's the right default for fresh imports of
// the same bookmarks file, but it means logic-only fixes (dead-link detection,
// brand-default tightening, status-semantics corrections) never apply to rows
// that were ingested under older code.
//
// Reclassify walks every Instance and applies the current pure-logic rules,
// updating ingest_status and partial_reason where they would now differ.
//
// Scope of pure-logic rules currently handled:
//   - Dead-link detection (hard via fc_status_code, soft via title pattern)
//   - Brand-default detection (tightened heuristic)
//   - Legacy resolved_via_local_authority migration
//
// Rules requiring network re-fetch (e.g., re-call Firecrawl on a row that was
// previously partial:blocked) are out of scope — those need a separate path that
// burns credits. For that, drop the DB and re-ingest.

import type { DB } from "./db.js";
import { isBrandDefaultTitle } from "./parsers/web-peek.js";
import { looksLikeDeadLinkTitle } from "./sources/web.js";

export interface ReclassifyResult {
  scanned: number;
  unchanged: number;
  transitions: Record<string, number>; // "ok→dead_link", "blocked→dead_link", etc.
  samples: Array<{ from: string; to: string; url: string; reason: string }>;
}

interface InstanceRow {
  id: string;
  source: string;
  url_canonical: string;
  title: string | null;
  source_payload_json: string;
  ingest_status: string;
  partial_reason: string | null;
}

// Partial-reasons that are pure-logic predicates (can be upgraded to ok if
// the predicate stops firing). Other reasons (blocked, failed, paywalled, etc.)
// reflect missing data, not a current-code judgment, so we never upgrade those
// to ok via reclassify — only network re-fetch can.
const LOGIC_DERIVED_PARTIAL_REASONS = new Set([
  "brand_default_title",
  "dead_link",
]);

// Partial-reasons indicating "we couldn't fetch" that should be sharpened to
// dead_link if FC's recorded upstream status_code says the page is gone.
// Sharpening is downward (partial→partial different reason); never upgrades to ok.
const SHARPENABLE_TO_DEAD_LINK = new Set([
  "blocked",
  "failed",
  "peek_exception",
  "no_og_tags",
]);

export function reclassifyAll(db: DB): ReclassifyResult {
  const result: ReclassifyResult = {
    scanned: 0,
    unchanged: 0,
    transitions: {},
    samples: [],
  };

  const rows = db.prepare(
    `SELECT id, source, url_canonical, title, source_payload_json, ingest_status, partial_reason
     FROM instances`
  ).all() as unknown as InstanceRow[];

  const update = db.prepare(
    `UPDATE instances
     SET ingest_status = ?, partial_reason = ?, source_payload_json = ?
     WHERE id = ?`
  );

  for (const row of rows) {
    result.scanned++;
    const evaluation = evaluateRow(row);
    if (evaluation === null) {
      result.unchanged++;
      continue;
    }

    const transitionKey = transitionLabel(row, evaluation);
    result.transitions[transitionKey] = (result.transitions[transitionKey] ?? 0) + 1;
    if (result.samples.length < 8) {
      result.samples.push({
        from: stateLabel(row.ingest_status, row.partial_reason),
        to: stateLabel(evaluation.ingest_status, evaluation.partial_reason),
        url: row.url_canonical,
        reason: evaluation.reasonNote,
      });
    }

    update.run(
      evaluation.ingest_status,
      evaluation.partial_reason,
      evaluation.source_payload_json,
      row.id
    );
  }

  return result;
}

interface Evaluation {
  ingest_status: string;
  partial_reason: string | null;
  source_payload_json: string;
  reasonNote: string;
}

function evaluateRow(row: InstanceRow): Evaluation | null {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.source_payload_json) as Record<string, unknown>; }
  catch { /* malformed JSON — treat as empty; preserves the row */ }

  // ── Legacy YouTube migration ───────────────────────────────────────────
  // Instances marked partial under the pre-Fix-13 code path. The Instance
  // is structurally complete (channel_id resolved, title known, authority linked);
  // the partial flag was overly cautious about missing stats.
  if (row.source === "youtube" && row.partial_reason === "resolved_via_local_authority") {
    const newPayload = {
      ...payload,
      channel_resolution_path: "local_authority_match",
      has_full_channel_data: false,
    };
    return {
      ingest_status: "ok",
      partial_reason: null,
      source_payload_json: JSON.stringify(newPayload),
      reasonNote: "legacy local-authority instance → ok",
    };
  }

  // ── Web rules ──────────────────────────────────────────────────────────
  if (row.source !== "web") return null;

  const title = row.title;
  const url = row.url_canonical;
  const fcStatusCode = typeof payload.fc_status_code === "number" ? payload.fc_status_code : null;

  // Hard dead-link signal: FC saw upstream >= 400. Sharpens fetch-failure
  // partials (blocked/failed/peek_exception/no_og_tags) to dead_link, and
  // catches ok rows that should never have been ok.
  if (fcStatusCode !== null && fcStatusCode >= 400) {
    if (row.ingest_status !== "partial" || row.partial_reason !== "dead_link") {
      // Already-partial rows with a sharpenable reason or already-ok rows: both move to dead_link.
      const movable =
        row.ingest_status === "ok" ||
        (row.partial_reason !== null && SHARPENABLE_TO_DEAD_LINK.has(row.partial_reason));
      if (movable) {
        return {
          ingest_status: "partial",
          partial_reason: "dead_link",
          source_payload_json: row.source_payload_json,
          reasonNote: `fc_status_code=${fcStatusCode}`,
        };
      }
    }
  }

  // Soft dead-link signal: title matches dead-page pattern (catches "soft 404s"
  // where the server returned 200 with a Page-Not-Found template).
  if (row.ingest_status === "ok" && title && looksLikeDeadLinkTitle(title)) {
    return {
      ingest_status: "partial",
      partial_reason: "dead_link",
      source_payload_json: row.source_payload_json,
      reasonNote: `title pattern match`,
    };
  }

  // Brand-default detection. Two directions:
  //   ok → partial: tightened heuristic now flags a row that was previously ok
  //   partial → ok: relaxed heuristic no longer flags a row that was previously brand_default
  if (title) {
    const flags = isBrandDefaultTitle(title, url);
    if (row.ingest_status === "ok" && flags) {
      return {
        ingest_status: "partial",
        partial_reason: "brand_default_title",
        source_payload_json: row.source_payload_json,
        reasonNote: "brand-default title on deep URL",
      };
    }
    if (row.partial_reason === "brand_default_title" && !flags) {
      return {
        ingest_status: "ok",
        partial_reason: null,
        source_payload_json: row.source_payload_json,
        reasonNote: "no longer flagged by tightened brand-default check",
      };
    }
  }

  return null;
}

function stateLabel(status: string, reason: string | null): string {
  return reason ? `${status}:${reason}` : status;
}

function transitionLabel(row: InstanceRow, e: Evaluation): string {
  return `${stateLabel(row.ingest_status, row.partial_reason)} → ${stateLabel(e.ingest_status, e.partial_reason)}`;
}
