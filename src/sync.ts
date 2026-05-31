import { Notice, normalizePath, type App } from "obsidian";
import { ApiError, type ApiClient } from "./api.js";
import type { NoteRow, NoteSummary, RecordingRow } from "./types.js";
import {
  buildBaseName,
  NOTE_WRITER_VERSION,
  NOTES_SUBFOLDER,
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
 * Scan the Cordari folder once per sync and return a cordari_id → local
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
    const id = typeof fm?.cordari_id === "string" ? fm.cordari_id : null;
    const filename = typeof fm?.filename === "string" ? fm.filename : null;
    // Missing / non-numeric version means the file was written by a
    // pre-versioning plugin build (or a pre-rebrand build); treat as
    // v0 so reasonToSync triggers a rewrite on the next pass.
    const rawVersion = fm?.cordari_writer_version;
    const writerVersion = typeof rawVersion === "number" ? rawVersion : 0;
    if (id && filename) cache.set(id, { filename, mdPath: f.path, writerVersion });
  }
  return cache;
}

/**
 * Top-level sync entry point. Reconciles recordings and handwritten
 * notes in sequence — both are read-only pull integrations against the
 * Cordari API and share the same auth + folder root. Runs are not
 * reentrant; the plugin gates this behind an in-memory flag.
 *
 * A 401 from either lane bubbles up to onUnauthorized and aborts the
 * pass; other errors are isolated to their lane so a notes-side outage
 * (e.g. during the /api/v1/notes rollout window where the endpoint may
 * 404) doesn't take down recordings sync.
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
    console.error("[Cordari] sync failed", err);
    new Notice(`Cordari sync failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.debug("[Cordari] recordings sync start", { localKnown: localIndex.size });

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
        console.debug("[Cordari] synced recording", {
          id: row.id,
          filename: row.filename,
          status: row.status,
          reason,
          wroteAudioBytes: r.wroteAudioBytes,
          audioReused: r.audioReused,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err;
        console.warn("[Cordari] syncOne (recording) failed; continuing", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page.items.length < pageSize) break;
    offset += pageSize;
  }

  console.debug("[Cordari] recordings sync done", { scanned, synced, skipped, audioReused });
}

/**
 * Return a short string describing why this recording needs work, or null
 * if the local state is already correct. Checks in this order:
 *   1. Not complete on the server — pending transcript/summary may still
 *      arrive; re-fetch so the file stays current.
 *   2. No local .md with this cordari_id — either never synced or the
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
      console.warn("[Cordari] audio download failed; continuing without it", err);
    }
  } else if (r.audioDownloadedAt && audioExists) {
    audioReused = true;
  }

  await writer.writeRecording(r, audioBytes);
  return { wroteAudioBytes: audioBytes?.byteLength ?? 0, audioReused };
}

// ---- Notes sync (handwritten / Boox via /api/v1/notes) ----

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
 * Scan the notes subfolder once per pass and return a cordari_id →
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
    const id = typeof fm?.cordari_id === "string" ? fm.cordari_id : null;
    const filename = typeof fm?.filename === "string" ? fm.filename : null;
    const rawVersion = fm?.cordari_writer_version;
    const writerVersion = typeof rawVersion === "number" ? rawVersion : 0;
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
 * the markdown. Recognition + summary bodies are fetched per note when
 * recognized; for pending recognition we still write a stub so the
 * file is visible and gets filled in on the next pass.
 *
 * Rollout fallback: if `/api/v1/notes` returns 404 (server not yet
 * deployed with the notes router), log and return without taking down
 * the recordings sync that already ran.
 */
export async function runNotesSync(opts: SyncOpts): Promise<void> {
  const writer = new VaultWriter({
    app: opts.app,
    root: opts.root,
  });

  const localIndex = buildNotesLocalIndex(opts.app, opts.root);
  console.debug("[Cordari] notes sync start", { localKnown: localIndex.size });

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
      if (err instanceof ApiError && err.status === 404) {
        // Endpoint not yet deployed on this Cordari instance — silent
        // skip is preferable to a Notice every poll during the rollout
        // window. Recordings already ran above.
        console.debug("[Cordari] notes endpoint unavailable (404); skipping notes sync");
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
        console.debug("[Cordari] synced note", {
          id: row.id,
          filename: row.filename,
          recognitionStatus: row.recognitionStatus,
          reason,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err;
        console.warn("[Cordari] syncOneNote failed; continuing", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (page.items.length < pageSize) break;
    offset += pageSize;
  }

  console.debug("[Cordari] notes sync done", { scanned, synced, skipped });
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
  // Detail call gives us authoritative metadata + the summary id list
  // (the list endpoint only returns counts). Same idempotency posture
  // as recordings — we always write through writer.writeNote, which
  // creates-or-updates by cordari_id.
  const detail = await client.noteDetail(row.id);

  // Recognized markdown: skip the fetch when not ready (server 404s
  // anyway; we save the round trip and the writer renders the
  // "_recognition pending_" stub from the detail row).
  const recognized =
    detail.recognitionStatus === "ready"
      ? await client.noteRecognized(detail.id)
      : null;

  // Summary bodies: one round-trip per summary. The detail only carries
  // metadata; full markdown comes from
  // /api/v1/notes/:id/summaries/:assetId. Concurrent fetches keep the
  // wall-clock down on notes with multiple summaries.
  const summaries: NoteSummary[] = [];
  if (detail.summaries.length > 0) {
    const fetched = await Promise.all(
      detail.summaries.map((s) => client.noteSummary(detail.id, s.id)),
    );
    for (const s of fetched) {
      if (s) summaries.push(s);
    }
  }

  await writer.writeNote(detail, recognized?.contentText ?? null, summaries);
}
