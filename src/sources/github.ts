// GitHub source pipeline.
// /repos/{owner}/{repo}, /users/{name}, /orgs/{name} (when user.type=Organization).
// Gracefully degrades when GITHUB_TOKEN absent.
import type { RawBookmark, Kind } from "../types.js";
import type { IngestContext } from "../context.js";
import { canonicalizeGithub } from "../canonicalize.js";
import { createWorkForInstance, findOrCreateCreatorAuthority } from "../authorities.js";
import { upsertItem } from "./web.js";

export async function ingestGithub(ctx: IngestContext, bookmarks: RawBookmark[]): Promise<void> {
  ctx.emit({ kind: "pipeline_start", source: "github", total: bookmarks.length });

  // Group by nativeId (owner/repo or login) so duplicates within this run share an Instance.
  const grouped = new Map<string, {
    kind: "github-repo" | "github-creator-page";
    canonical: string;
    bookmarks: RawBookmark[];
  }>();

  for (const bm of bookmarks) {
    const canon = canonicalizeGithub(bm.url);
    if (!canon) {
      ctx.recordError({
        source: "github", raw_input: bm.url, source_export_file: bm.source_export_file,
        classification_attempt: "github", error_type: "malformed_url",
        error_message: `Could not parse GitHub URL: ${bm.url}`,
      });
      continue;
    }
    const existing = grouped.get(canon.nativeId);
    if (existing) existing.bookmarks.push(bm);
    else grouped.set(canon.nativeId, { kind: canon.kind, canonical: canon.canonical, bookmarks: [bm] });
  }

  let created = 0;
  let deduped = 0;
  let i = 0;
  const total = grouped.size;

  for (const [nativeId, group] of grouped) {
    i++;
    if (i > 0 && i % 50 === 0) {
      ctx.emit({ kind: "pipeline_progress", source: "github", done: i, total });
    }

    const instanceId = group.kind === "github-repo"
      ? `inst_gh_${nativeId.replace("/", "_")}`
      : `inst_ghuser_${nativeId}`;

    if (ctx.hasSeenInstance("github", nativeId)) {
      for (const bm of group.bookmarks) {
        upsertItem(ctx, "github", instanceId, bm, group.canonical);
      }
      deduped += group.bookmarks.length;
      continue;
    }

    try {
      if (group.kind === "github-repo") {
        await ingestRepoGroup(ctx, nativeId, group.canonical, group.bookmarks);
      } else {
        await ingestUserPageGroup(ctx, nativeId, group.canonical, group.bookmarks);
      }
      created++;
    } catch (e: any) {
      ctx.recordError({
        source: "github", raw_input: group.bookmarks[0].url,
        source_export_file: group.bookmarks[0].source_export_file,
        classification_attempt: `github.${group.kind}`,
        error_type: "parse_exception",
        error_message: e?.message ?? "unknown",
        exception_traceback: e?.stack,
      });
    }
  }
  ctx.emit({ kind: "pipeline_done", source: "github", created, deduped });
}

async function ingestRepoGroup(
  ctx: IngestContext, fullName: string, canonical: string, bookmarks: RawBookmark[]
): Promise<void> {
  const [owner, repo] = fullName.split("/");
  const token = ctx.config.githubToken;

  if (!token) {
    createPartialNoApiForGroup(ctx, fullName, canonical, bookmarks, "github-repo", "missing_api_key");
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pre-kompl/0.1",
  };

  const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  ctx.githubRequestsUsed++;
  if (!repoResp.ok) {
    createPartialNoApiForGroup(ctx, fullName, canonical, bookmarks, "github-repo", `repo_${repoResp.status}`);
    return;
  }
  const data = await repoResp.json() as any;

  let languages: { name: string; bytes: number }[] = [];
  try {
    const langResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers });
    ctx.githubRequestsUsed++;
    if (langResp.ok) {
      const lang = await langResp.json() as Record<string, number>;
      languages = Object.entries(lang)
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 3);
    }
  } catch { /* ignore */ }

  const creatorAuthorityId = findOrCreateCreatorAuthority(
    ctx.db, "github", data.owner?.login ?? owner, owner,
    {
      variants: [],
      external_ids: { github_login: owner, github_owner_type: data.owner?.type ?? "User" },
    }
  );
  ctx.authoritiesTouched.add(creatorAuthorityId);

  const instanceId = `inst_gh_${owner}_${repo}`;
  const workId = createWorkForInstance(ctx.db, data.name ?? repo, data.description);

  const sourcePayload = {
    github_repo_id: data.id,
    full_name: data.full_name,
    default_branch: data.default_branch,
    is_fork: data.fork,
    is_archived: data.archived,
    is_template: data.is_template,
    visibility: data.visibility,
    language: data.language,
    languages_top3: languages,
    license_spdx: data.license?.spdx_id ?? null,
    stargazers_count: data.stargazers_count,
    forks_count: data.forks_count,
    subscribers_count: data.subscribers_count,
    open_issues_count: data.open_issues_count,
    size_kb: data.size,
    created_at: data.created_at,
    updated_at: data.updated_at,
    pushed_at: data.pushed_at,
    topics: data.topics ?? [],
    has_issues: data.has_issues,
    has_wiki: data.has_wiki,
    has_pages: data.has_pages,
    has_discussions: data.has_discussions,
    homepage: data.homepage,
  };

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'github', 'github-repo', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, 'ok', NULL, ?)
  `).run(
    instanceId, fullName, canonical,
    data.name ?? repo, data.description, JSON.stringify(sourcePayload),
    creatorAuthorityId, workId, Date.now()
  );

  ctx.markInstanceSeen("github", fullName);
  ctx.instancesCreated++;
  ctx.byStatus.ok++;
  for (const bm of bookmarks) upsertItem(ctx, "github", instanceId, bm, canonical);
}

async function ingestUserPageGroup(
  ctx: IngestContext, login: string, canonical: string, bookmarks: RawBookmark[]
): Promise<void> {
  const token = ctx.config.githubToken;
  if (!token) {
    createPartialNoApiForGroup(ctx, login, canonical, bookmarks, "github-creator-page", "missing_api_key");
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pre-kompl/0.1",
  };

  const resp = await fetch(`https://api.github.com/users/${login}`, { headers });
  ctx.githubRequestsUsed++;
  if (!resp.ok) {
    createPartialNoApiForGroup(ctx, login, canonical, bookmarks, "github-creator-page", `user_${resp.status}`);
    return;
  }
  const data = await resp.json() as any;

  const creatorAuthorityId = findOrCreateCreatorAuthority(
    ctx.db, "github", data.name ?? login, login,
    {
      variants: [login],
      external_ids: { github_login: login, github_owner_type: data.type, github_user_id: String(data.id) },
      description: data.bio,
    }
  );
  ctx.authoritiesTouched.add(creatorAuthorityId);

  const instanceId = `inst_ghuser_${login}`;
  const workId = createWorkForInstance(ctx.db, data.name ?? login, data.bio);

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'github', 'github-creator-page', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, 'ok', NULL, ?)
  `).run(
    instanceId, login, canonical,
    data.name ?? login, data.bio,
    JSON.stringify({
      type: data.type, followers: data.followers, following: data.following,
      public_repos: data.public_repos, blog: data.blog, location: data.location,
    }),
    creatorAuthorityId, workId, Date.now()
  );

  ctx.markInstanceSeen("github", login);
  ctx.instancesCreated++;
  ctx.byStatus.ok++;
  for (const bm of bookmarks) upsertItem(ctx, "github", instanceId, bm, canonical);
}

function createPartialNoApiForGroup(
  ctx: IngestContext, nativeId: string, canonical: string,
  bookmarks: RawBookmark[], kind: Kind, reason: string
): void {
  const instanceId = kind === "github-repo"
    ? `inst_gh_${nativeId.replace("/", "_")}`
    : `inst_ghuser_${nativeId}`;
  const titleHint = bookmarks.find((b) => b.title)?.title ?? null;
  const workId = createWorkForInstance(ctx.db, titleHint, null);
  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'github', ?, ?, ?, ?, NULL, NULL, NULL, '[]', ?, 'unknown', 0, 'partial', ?, ?)
  `).run(instanceId, kind, nativeId, canonical, titleHint, workId, reason, Date.now());
  ctx.markInstanceSeen("github", nativeId);
  ctx.instancesCreated++;
  ctx.byStatus.partial++;
  for (const bm of bookmarks) upsertItem(ctx, "github", instanceId, bm, canonical);
}
