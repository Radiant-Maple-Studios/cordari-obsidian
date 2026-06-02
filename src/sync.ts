import { Notice, normalizePath, type App } from "obsidian";
import { ApiError, type ApiClient } from "./api.js";
import type { NoteRow, RecordingRow } from "./types.js";
import {
  buildBaseName,
  NOTE_WRITER_VERSION,
  NOTES_SUBFOLDER,
  readFrontmatterId,
  readFrontmatterWriterVersion,
  VaultWriter,
  WRITER_VERSION,
} from "./writer.js";

export interface SyncOpts {
  app: App;
  client: ApiClient;
  root: string;
  onUnauthorized: () => void;
}

interface LocalEntry {
  filename: string;
  mdPath: string;
  writerVersion: number;
}

/**
 * Scan the RoveNotes folder once per sync and return a rovenotes_id → local
 * state map from YAML frontmatter. Used to:
 *   - detect Plaud-side renames on complete recordings (re-fetch to
 *     update filename in frontmatter and rename the TFile),
 *   - detect missing local files on ids we've seen before (re-push to
 *     self-heal after a deleted/corrupt file),
 *   - avoid re-downloading the same audio when the .ogg is already next
 *     to the .md.
 */
function buildLocalIndex(app: App, root: string): Map<string, LocalEntry> {
  const cache = new Map<string, LocalEntry>();
  const prefix = root.endsWith("/") ? root : `${root}/`;
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    const id = readFrontmatterId(fm);
    const filename = typeof fm?.filename === "string" ? fm.filename : null;
    // Missing / non-numeric version means the file was written by a
    // pre-versioning plugin build; treat as v0 so reasonToSync triggers
    // a rewrite on the next pass. A file written by the pre-rebrand
    // cordari-notes plugin reports its `cordari_writer_version` (e.g. 3)
    // via the helper — `local < WRITER_VERSION (= 4)` still trips the
    // writer-version-drift branch, which rewrites the file with the new
    // `rovenotes_*` keys.
    const writerVersion = readFrontmatterWriterVersion(fm);
    if (id && filename) cache.set(id, { filename, mdPath: f.path, writerVersion });
  }
  return cache;
}

/**
 * Top-level sync entry point. Reconciles recordings and handwritten
 * notes in sequence — both are read-only pull integrations against the
 * RoveNotes API and share the same auth + folder root. Runs are not
 * reentrant; the plugin gates this behind an in-memory flag.
 *
 * Only the recordings lane's auth result drives the connection-level
 * disconnect path: a 401 from listRecordings or recordingDetail
 * bubbles up here and fires onUnauthorized. The notes lane (a
 * secondary, optional integration) swallows its own 401/403/404 so a
 * server-side misconfiguration on /api/boox-notes can't tear down the
 * link to a working /api/recordings — that was the COR-352 bug.
 */
export async function runSync(opts: SyncOpts): Promise<void> {
  try {
    await runRecordingsSync(opts);
    await runNotesSync(opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      opts.onUnauthorized();
      return;
    }
    console.error("[RoveNotes] sync failed", err);
    new Notice(`RoveNotes sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Drive-style reconciliation pass for recordings. Always lists every
 * recording, cheap-skips the ones whose local state already matches,
 * fetches detail + audio only for the ones that need work. Writes are
 * idempotent — same content produces the same file on disk. No
 * watermark optimization; the server call + in-vault scan are both
 * cheap, and this buys us self-healing on vault-side file deletions or
 * renames.
 */
export async function runRecordingsSync(opts: SyncOpts): Promise<void> {
  const writer = new VaultWriter({
    app: opts.app,
    root: opts.root,
  });

  const localIndex = buildLocalIndex(opts.app, opts.root);
  console.debug("[RoveNotes] recordings sync start", { localKnown: localIndex.size });

  let offset = 0;
  let scanned = 0;
  let synced = 0;
  let skipped = 0;
  let audioReused = 0;
  const pageSize = 50;

  while (true) {
    const page = await opts.client.listRecordings({ limit: pageSize, offset });
    if (page.items.length === 0) break;
    scanned += page.items.length;

    for (const row of page.items) {
      const reason = reasonToSync(row, localIndex, opts.app);
      if (!reason) {
        skipped++;
        continue;
      }
      try {
        const r = await syncOne(row, opts.client, writer, opts.root, opts.app);
        synced++;
        if (r.audioReused) audioReused++;
        console.debug("[RoveNotes] synced recording", {
          id: row.id,
          filename: row.filename,
          status: row.status,
          reason,
          wroteAudioBytes: r.wroteAudioBytes,
          audioReused: r.audioReused,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err;
        console.warn("[RoveNotes] syncOne (recording) failed; continuing", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page.items.length < pageSize) break;
    offset += pageSize;
  }

  console.debug("[RoveNotes] recordings sync done", { scanned, synced, skipped, audioReused });
}

/**
 * Return a short string describing why this recording needs work, or null
 * if the local state is already correct. Checks in this order:
 *   1. Not complete on the server — pending transcript/summary may still
 *      arrive; re-fetch so the file stays current.
 *   2. No local .md with this rovenotes_id — either never synced or the
 *      user/sync error deleted it; re-push.
 *   3. Local md exists but at the wrong path for the current filename —
 *      Plaud (or the user) renamed the recording.
 */
function reasonToSync(
  row: RecordingRow,
  localIndex: Map<string, LocalEntry>,
  app: App,
): string | null {
  if (row.status !== "complete") return "status-pending";

  const local = localIndex.get(row.id);
  if (!local) return "local-missing";
  if (local.filename !== row.filename) return "filename-drift";

  // Writer bumps WRITER_VERSION whenever composeMarkdown's layout or
  // wording changes. Files written by older plugin builds get rewritten
  // so stale stubs / removed fields don't linger in the vault.
  if (local.writerVersion < WRITER_VERSION) return "writer-version-drift";

  // Defensive: the frontmatter says there's a local file, but the TFile is
  // actually gone from the adapter (rare — cache races, external sync
  // tools). Fall back to re-pushing.
  const path = normalizePath(local.mdPath);
  if (!app.vault.getAbstractFileByPath(path)) return "local-missing";

  return null;
}

async function syncOne(
  row: RecordingRow,
  client: ApiClient,
  writer: VaultWriter,
  root: string,
  app: App,
): Promise<{ wroteAudioBytes: number; audioReused: boolean }> {
  const detail = await client.recordingDetail(row.id);
  const r = detail.recording;

  // Skip the audio download when the target .ogg already exists in the
  // vault — cheap local check, saves tens of megabytes per reconciled
  // recording on big corpora. When Plaud renames, the target path
  // changes; the writer will rename the existing .ogg to the new name
  // on its own, so we only redownload when the file truly isn't there.
  const baseName = buildBaseName(r);
  const audioPath = normalizePath(`${root}/${baseName}.ogg`);
  const audioExists = !!app.vault.getAbstractFileByPath(audioPath);

  let audioBytes: ArrayBuffer | null = null;
  let audioReused = false;
  if (r.audioDownloadedAt && detail.audioUrl && !audioExists) {
    try {
      audioBytes = await client.downloadBinary(detail.audioUrl);
    } catch (err) {
      console.warn("[RoveNotes] audio download failed; continuing without it", err);
    }
  } else if (r.audioDownloadedAt && audioExists) {
    audioReused = true;
  }

  await writer.writeRecording(r, audioBytes);
  return { wroteAudioBytes: audioBytes?.byteLength ?? 0, audioReused };
}

// ---- Notes sync (handwritten / Boox via /api/boox-notes) ----

interface LocalNoteEntry {
  filename: string;
  mdPath: string;
  writerVersion: number;
  /**
   * Server's `updatedAt` epoch ms snapshot from the last write. Drives
   * the cheap re-fetch decision: list response gives us a fresh
   * updatedAt; if it's newer than what we have on disk, the note has
   * been touched (new recognition output, new summary, rename) and we
   * pull detail + bodies again. Otherwise we skip.
   */
  updatedAt: number;
}

/**
 * Scan the notes subfolder once per pass and return a rovenotes_id →
 * local entry map from YAML frontmatter. Notes live under
 * `<root>/<NOTES_SUBFOLDER>/` so this is scoped to that prefix; a
 * recording with the same id would not be considered a note.
 */
function buildNotesLocalIndex(app: App, root: string): Map<string, LocalNoteEntry> {
  const cache = new Map<string, LocalNoteEntry>();
  const prefix = `${root}/${NOTES_SUBFOLDER}/`;
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    const id = readFrontmatterId(fm);
    const filename = typeof fm?.filename === "string" ? fm.filename : null;
    const writerVersion = readFrontmatterWriterVersion(fm);
    const rawUpdated = fm?.updated_at;
    // YAML may carry the timestamp as a Date (when Obsidian parses ISO
    // strings) or as a plain string we wrote ourselves; accept both.
    const updatedAt =
      typeof rawUpdated === "number"
        ? rawUpdated
        : typeof rawUpdated === "string"
          ? Date.parse(rawUpdated) || 0
          : rawUpdated instanceof Date
            ? rawUpdated.getTime()
            : 0;
    if (id && filename) cache.set(id, { filename, mdPath: f.path, writerVersion, updatedAt });
  }
  return cache;
}

/**
 * Same reconciliation shape as the recordings sync. Lists every note,
 * decides per-row whether a fetch+write is needed, then materializes
 * the markdown. The detail call returns recognition + summary bodies
 * inline (one fetch per note); for pending recognition we still write
 * a stub so the file is visible and gets filled in on the next pass.
 *
 * The notes lane is treated as optional infrastructure on top of
 * recordings: a 401, 403, or 404 from /api/boox-notes is swallowed
 * (warn-logged, no Notice spam) instead of propagating up to
 * onUnauthorized. A misconfigured / unavailable notes endpoint must
 * never tear down the authenticated link that recordings just
 * confirmed works — see runSync's doc comment for the COR-352 context.
 */
export async function runNotesSync(opts: SyncOpts): Promise<void> {
  const writer = new VaultWriter({
    app: opts.app,
    root: opts.root,
  });

  const localIndex = buildNotesLocalIndex(opts.app, opts.root);
  console.debug("[RoveNotes] notes sync start", { localKnown: localIndex.size });

  let offset = 0;
  let scanned = 0;
  let synced = 0;
  let skipped = 0;
  const pageSize = 50;

  while (true) {
    let page;
    try {
      page = await opts.client.listNotes({ limit: pageSize, offset });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 404 || err.status === 401 || err.status === 403)
      ) {
        // Notes endpoint not reachable on this RoveNotes instance —
        // 404 (router not deployed), 401 (token scope not admitted),
        // 403 (notes permission denied). Skip silently; recordings
        // already ran above and any auth issue with the *primary*
        // /api/recordings surface would have surfaced there.
        console.warn(
          `[RoveNotes] notes endpoint unavailable (HTTP ${err.status}); skipping notes sync without disconnecting`,
        );
        return;
      }
      throw err;
    }
    if (page.items.length === 0) break;
    scanned += page.items.length;

    for (const row of page.items) {
      const reason = reasonToSyncNote(row, localIndex, opts.app, opts.root);
      if (!reason) {
        skipped++;
        continue;
      }
      try {
        await syncOneNote(row, opts.client, writer);
        synced++;
        console.debug("[RoveNotes] synced note", {
          id: row.id,
          filename: row.filename,
          recognitionStatus: row.recognitionStatus,
          reason,
        });
      } catch (err) {
        // Per-row auth failures are also swallowed (don't re-throw 401)
        // — see runSync's doc comment. A note-side 401 here would
        // disconnect the user even though recordings is healthy.
        console.warn("[RoveNotes] syncOneNote failed; continuing", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page.items.length < pageSize) break;
    offset += pageSize;
  }

  console.debug("[RoveNotes] notes sync done", { scanned, synced, skipped });
}

/**
 * Decide whether a note row needs a re-fetch + write, mirroring the
 * recording-side `reasonToSync`. Checks in order:
 *   1. No local file → write.
 *   2. Filename drift → upstream rename, fall through to re-fetch+rename.
 *   3. Writer version drift → schema changed, rewrite.
 *   4. Server-side `updatedAt` newer than what we wrote → re-fetch
 *      (new summary lands, recognition flips ready, etc.).
 *   5. Recognition not yet ready → keep refreshing so the stub stays
 *      live until recognition completes.
 *   6. Local file path moved or missing on disk → re-push.
 */
function reasonToSyncNote(
  row: NoteRow,
  localIndex: Map<string, LocalNoteEntry>,
  app: App,
  root: string,
): string | null {
  const local = localIndex.get(row.id);
  if (!local) return "local-missing";
  if (local.filename !== row.filename) return "filename-drift";
  if (local.writerVersion < NOTE_WRITER_VERSION) return "writer-version-drift";
  if (local.updatedAt < row.updatedAt) return "server-updated";
  if (row.recognitionStatus !== "ready") return "recognition-pending";

  const path = normalizePath(local.mdPath);
  if (!app.vault.getAbstractFileByPath(path)) return "local-missing";

  // Sanity check: ensure the file lives under the notes prefix; a stray
  // entry from a prior path scheme should be re-pushed into place.
  if (!local.mdPath.startsWith(`${root}/${NOTES_SUBFOLDER}/`)) return "path-drift";

  return null;
}

async function syncOneNote(
  row: NoteRow,
  client: ApiClient,
  writer: VaultWriter,
): Promise<void> {
  // One fetch — /api/boox-notes/:id bundles the recognized markdown
  // (per page) and full summary bodies inline. Same idempotency
  // posture as recordings: writer.writeNote creates-or-updates by
  // rovenotes_id.
  const { note } = await client.noteDetail(row.id);

  // Assemble the recognized markdown from per-page chunks. Matches the
  // server's getNoteMarkdown() helper exactly — non-empty pages joined
  // by a blank line — so destinations and the vault see identical
  // text. Null when recognition isn't ready or the recognizer hasn't
  // emitted any pages yet; the writer falls back to its
  // "_recognition pending_" stub in that case.
  const recognizedText =
    note.recognitionStatus === "ready"
      ? note.recognizedPages
          .map((p) => p.contentText)
          .filter((t) => t.trim().length > 0)
          .join("\n\n") || null
      : null;

  await writer.writeNote(note, recognizedText, note.summaries);
}
