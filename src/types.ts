// All types for pre-kompl v0.
// Schemas mirror /pre-kompl-spec/ but flattened for SQLite.
// JSON columns: subject_authority_ids (Instance), variants/broader_ids/narrower_ids (Authority).

export type Source = "youtube" | "github" | "twitter" | "web";
export type IngestStatus = "ok" | "partial" | "error";
export type AccessStatus =
  | "live"
  | "broken"
  | "region_locked"
  | "paywalled"
  | "private"
  | "unknown";

export type Kind =
  | "video"
  | "video-playlist"
  | "creator-page"
  | "github-repo"
  | "github-creator-page"
  | "tweet"
  | "article"
  | "blog-post"
  | "paper"
  | "docs"
  | "forum-post"
  | "paywalled"
  | "other"
  | "gist-stub"; // out-of-scope routing for gists

export type ErrorType =
  | "no_url"
  | "no_native_id"
  | "malformed_url"
  | "parse_exception"
  | "unsupported_url"
  | "fetch_failure_total"
  | "unrecognized_binary"
  | "missing_api_key";

export type FileType =
  | "browser_bookmarks"
  | "twitter_json"
  | "notes"
  | "binary"
  | "empty"
  | "unrecognized";

// ──────────── Records ────────────

export interface Work {
  id: string;
  title: string | null;
  description: string | null;
  created_at: number; // unix ms
  updated_at: number;
}

export interface Instance {
  id: string;
  source: Source;
  kind: Kind;
  native_id: string;
  url_canonical: string;

  title: string | null;
  description: string | null;

  // Source-specific payload — JSON blob for v0 to avoid one column per source.
  // Real schemas in the spec would expand each source's fields.
  source_payload_json: string | null;

  creator_authority_id: string | null;
  subject_authority_ids_json: string; // JSON array, default "[]"

  work_id: string;

  access_status: AccessStatus;
  is_archived_url: number; // 0/1

  ingest_status: IngestStatus;
  partial_reason: string | null;

  fetched_at: number;
}

export interface Item {
  id: string;
  instance_id: string | null; // null only for error-skeleton Items

  url_as_saved: string;
  url_canonical: string;

  save_date: number;
  save_date_is_inferred: number; // 0/1

  bookmark_folder_path: string; // pipe-delimited, "" for root
  user_notes: string | null;

  source_export_file: string;
  ingested_at: number;
  ingest_status: IngestStatus;
  ingest_error_id: string | null;
}

export interface Authority {
  id: string;
  type: "creator" | "subject" | "source" | "kind";
  source: Source | null;
  preferred: string;
  variants_json: string; // JSON array
  broader_ids_json: string;
  narrower_ids_json: string;
  scope_note: string | null;
  external_ids_json: string | null;
  baseline_subjects_json: string; // JSON array of subject ids
  created_at: number;
  updated_at: number;
}

export interface IngestionError {
  id: string;
  occurred_at: number;
  source: Source | "unclassified";
  raw_input: string;
  source_export_file: string;
  classification_attempt: string | null;
  error_type: ErrorType;
  error_message: string;
  exception_traceback: string | null;
  item_id: string | null;
  resolved: number;
  resolution_action: string | null;
  resolved_at: number | null;
}

// ──────────── Ingest-time intermediate shapes ────────────

export interface RawBookmark {
  url: string;
  title: string | null;
  save_date: number; // unix ms; ingest time if inferred
  save_date_is_inferred: boolean;
  bookmark_folder_path: string;
  user_notes: string | null;
  source_export_file: string;
}

export interface FileClassification {
  path: string;
  filename: string;
  type: FileType;
  entry_count: number;
  reason?: string; // why skipped, if skipped
}

export interface IngestSummary {
  files_processed: number;
  files_skipped: number;
  items_created: number;
  instances_created: number;
  authorities_created_or_referenced: number;
  by_status: { ok: number; partial: number; error: number };
  by_source: Record<Source, number>;
  elapsed_ms: number;
  quota: {
    youtube_units?: number;
    github_requests?: number;
    firecrawl_credits?: number;
  };
}
