import { normalizePath, TFile, type App } from "obsidian";
import { ROVENOTES_SERVER_URL } from "./api.js";
import type { NoteDetail, RecordingDetail, Summary } from "./types.js";

// Writes the per-recording markdown + audio into the vault and keeps them
// up to date on re-sync. Lookup by `rovenotes_id` in YAML frontmatter so
// renames (either side) never create duplicates — we rewrite the existing
// file in place, same rovenotes_id → same TFile. The lookup also accepts
// the legacy `cordari_id` key so vaults previously synced by the
// cordari-notes plugin migrate on the next pass without orphaning files.

/**
 * Bump this any time composeMarkdown's layout or wording changes. Files
 * whose frontmatter `rovenotes_writer_version` is below this value get
 * re-synced so stale content (old stubs, dropped fields, reshaped
 * sections) doesn't linger in the vault forever.
 *
 * History:
 *   v2 — multi-summary support; switched from `summaryMarkdown` to
 *        `summaries[]` rendering; new "_summary pending_" stub text
 *        replaced "_(no summary available)_".
 *   v3 — rebrand Applaud → Cordari. Frontmatter keys switched from
 *        `applaud_id` / `applaud_url` / `applaud_writer_version` to
 *        `cordari_*`. Notes written by pre-v3 plugin builds looked
 *        "local-missing" to the sync layer and got fully rewritten.
 *   v4 — rebrand Cordari → RoveNotes. Frontmatter keys switched from
 *        `cordari_*` to `rovenotes_*`. Reads in this writer + the sync
 *        layer's local index accept either set, so existing files are
 *        rediscovered by id and modified in place on the next pass
 *        rather than orphaned beside fresh `rovenotes_*` duplicates.
 *        Body content below the YAML is still overwritten (same trade
 *        as the v3 migration); user-edited notes lose those edits.
 */
export const WRITER_VERSION = 4;

/**
 * Note-side analog of WRITER_VERSION. Notes are a separate file shape
 * (no audio, recognized markdown + summaries) and live in a subfolder;
 * versioning them separately means recording-layout tweaks don't churn
 * every note file and vice versa.
 *
 * History:
 *   v1 — initial notes support (COR-319 PR 8b): YAML + recognized text
 *        + summary sections + "Open in Cordari" footer.
 *   v2 — rebrand Cordari → RoveNotes. Same key swap + same legacy
 *        `cordari_*` fallback on reads as the recording-side v4; the
 *        footer also flips to "Open in RoveNotes".
 */
export const NOTE_WRITER_VERSION = 2;

/**
 * Read the recording/note id out of a markdown file's YAML frontmatter.
 * Prefers the current `rovenotes_id` key but falls back to the legacy
 * `cordari_id` so vaults synced by the cordari-notes plugin keep getting
 * matched to their server-side id during the migration window. New
 * writes only emit `rovenotes_id`, so each rewritten file drops the
 * legacy key on its next pass.
 */
export function readFrontmatterId(
  fm: Record<string, unknown> | undefined,
): string | null {
  const id = fm?.rovenotes_id ?? fm?.cordari_id;
  return typeof id === "string" ? id : null;
}

/**
 * Read the writer-version int out of a markdown file's YAML frontmatter,
 * accepting either the new or legacy key. A note that only carries the
 * legacy `cordari_writer_version` reports its own value (e.g. 3) — the
 * sync layer then sees `local < WRITER_VERSION (= 4)` and re-syncs the
 * file, which is what writes the new `rovenotes_*` keys. Missing / non-
 * numeric → 0 so pre-versioning builds also trigger a rewrite.
 */
export function readFrontmatterWriterVersion(
  fm: Record<string, unknown> | undefined,
): number {
  const v = fm?.rovenotes_writer_version ?? fm?.cordari_writer_version;
  return typeof v === "number" ? v : 0;
}

/**
 * Notes live in this subfolder under the configured root so they don't
 * commingle with recording markdown files. Same root → easy to point
 * Obsidian Dataview / Templater at either set independently.
 */
export const NOTES_SUBFOLDER = "Notes";

export interface WriterOpts {
  app: App;
  root: string;
}

export class VaultWriter {
  constructor(private readonly opts: WriterOpts) {}

  /**
   * Writes (or rewrites) the markdown file + audio for a single recording.
   * When `audioBytes` is null the caller is signalling "audio already
   * exists in the vault, or there's nothing to write" — we still handle
   * any rename of the existing .ogg to the current canonical name.
   */
  async writeRecording(detail: RecordingDetail, audioBytes: ArrayBuffer | null): Promise<TFile> {
    const { app, root } = this.opts;

    // Ensure folder exists.
    const folder = normalizePath(root);
    if (!app.vault.getAbstractFileByPath(folder)) {
      await app.vault.createFolder(folder);
    }

    const baseName = buildBaseName(detail);
    const audioRelName = `${baseName}.ogg`;
    const mdRelName = `${baseName}.md`;

    const existing = this.findExistingFile(detail.id);

    // If the recording was renamed upstream, rename the existing .ogg in
    // place before touching contents. The sync layer skips audio download
    // when the .ogg already exists, so this rename is how bytes follow
    // the new name without a redownload.
    const audioTargetPath = normalizePath(`${folder}/${audioRelName}`);
    const existingAudioForId = this.findExistingAudio(detail.id);
    if (
      existingAudioForId &&
      existingAudioForId.path !== audioTargetPath &&
      !app.vault.getAbstractFileByPath(audioTargetPath)
    ) {
      await app.fileManager.renameFile(existingAudioForId, audioTargetPath);
    }

    if (audioBytes) {
      const target = app.vault.getAbstractFileByPath(audioTargetPath);
      if (target instanceof TFile) {
        await app.vault.modifyBinary(target, audioBytes);
      } else {
        await app.vault.createBinary(audioTargetPath, audioBytes);
      }
    }

    const markdown = this.composeMarkdown(detail, audioRelName);
    const targetPath = normalizePath(`${folder}/${mdRelName}`);

    if (existing && existing.path !== targetPath) {
      await app.fileManager.renameFile(existing, targetPath);
    }

    const after = app.vault.getAbstractFileByPath(targetPath);
    if (after instanceof TFile) {
      await app.vault.modify(after, markdown);
      return after;
    }
    return await app.vault.create(targetPath, markdown);
  }

  /**
   * Writes (or rewrites) the markdown file for a single handwritten
   * note. Recognized markdown + summaries variant — no audio binary.
   * `recognized` is null when the note's recognitionStatus !== "ready"
   * yet (the server 404s `/recognized` in that case); we still write a
   * stub so the user sees the file appear and watches it fill in on
   * later passes.
   */
  async writeNote(
    detail: NoteDetail,
    recognizedText: string | null,
    summaries: Summary[],
  ): Promise<TFile> {
    const { app, root } = this.opts;
    const noteFolder = normalizePath(`${root}/${NOTES_SUBFOLDER}`);
    if (!app.vault.getAbstractFileByPath(noteFolder)) {
      await app.vault.createFolder(noteFolder);
    }
    const baseName = buildNoteBaseName(detail);
    const targetPath = normalizePath(`${noteFolder}/${baseName}.md`);

    const existing = this.findExistingNoteFile(detail.id);
    if (existing && existing.path !== targetPath) {
      await app.fileManager.renameFile(existing, targetPath);
    }
    const markdown = composeNoteMarkdown(detail, recognizedText, summaries);
    const after = app.vault.getAbstractFileByPath(targetPath);
    if (after instanceof TFile) {
      await app.vault.modify(after, markdown);
      return after;
    }
    return await app.vault.create(targetPath, markdown);
  }

  /**
   * Return the TFile whose frontmatter id matches `id`. Accepts the
   * legacy `cordari_id` key (via `readFrontmatterId`) so pre-rebrand
   * files are rediscovered and rewritten in place on the next sync.
   */
  private findExistingFile(id: string): TFile | null {
    const files = this.opts.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (!f.path.startsWith(this.opts.root + "/")) continue;
      const cache = this.opts.app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      if (readFrontmatterId(fm) === id) return f;
    }
    return null;
  }

  /**
   * Scoped to the notes subfolder so a recording markdown with the
   * (astronomically unlikely) same id doesn't get touched as a note.
   * The sync layer also reads this folder for its localIndex of notes.
   * Same legacy-key fallback as findExistingFile.
   */
  private findExistingNoteFile(id: string): TFile | null {
    const notesPrefix = `${this.opts.root}/${NOTES_SUBFOLDER}/`;
    for (const f of this.opts.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(notesPrefix)) continue;
      const cache = this.opts.app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      if (readFrontmatterId(fm) === id) return f;
    }
    return null;
  }

  /**
   * Match `.ogg` files to a recording id by the short-id suffix in the
   * filename (`..__{first8ofid}.ogg`). We don't get frontmatter on binary
   * files, so this is the best we can do without a sidecar index.
   */
  private findExistingAudio(id: string): TFile | null {
    const suffix = `__${id.slice(0, 8)}.ogg`;
    const root = this.opts.root;
    for (const f of this.opts.app.vault.getFiles()) {
      if (f.extension !== "ogg") continue;
      if (!f.path.startsWith(root + "/")) continue;
      if (f.path.endsWith(suffix)) return f;
    }
    return null;
  }

  private composeMarkdown(d: RecordingDetail, audioRelName: string): string {
    const state = d.status;
    const yaml = [
      "---",
      `rovenotes_id: ${d.id}`,
      `rovenotes_url: ${ROVENOTES_SERVER_URL}/recordings/${d.id}`,
      `rovenotes_writer_version: ${WRITER_VERSION}`,
      `date: ${new Date(d.startTime).toISOString()}`,
      `duration_ms: ${d.durationMs}`,
      `filename: ${yamlEscape(d.filename)}`,
      `state: ${state}`,
      "---",
      "",
    ].join("\n");

    const title = `# ${d.filename}`;
    const audioEmbed = d.audioDownloadedAt ? `![[${audioRelName}]]` : "_audio not yet downloaded_";

    const summarySection =
      d.summaries.length > 0
        ? d.summaries
            .map((s) => {
              const label = s.tabName ?? s.title ?? "Summary";
              return `## ${label}\n\n${(s.contentText ?? "").trim()}`;
            })
            .join("\n\n")
        : "## Summary\n\n_summary pending_";

    const transcriptSection =
      d.transcriptText && d.transcriptText.trim()
        ? `## Transcript\n\n${d.transcriptText.trim()}`
        : d.hasTranscript
          ? "## Transcript\n\n_(no transcript available)_"
          : "## Transcript\n\n_transcript pending_";

    return [yaml, title, "", audioEmbed, "", summarySection, "", transcriptSection, ""].join("\n");
  }
}

/**
 * Canonical filename stem for a recording. Exported so the sync layer can
 * predict the path and check whether the audio is already in the vault
 * before deciding to redownload.
 */
export function buildBaseName(
  d: Pick<RecordingDetail, "id" | "filename" | "startTime">,
): string {
  const dateStamp = new Date(d.startTime).toISOString().slice(0, 10);
  const safeFilename = sanitizeForFs(d.filename) || "recording";
  const shortId = d.id.slice(0, 8);
  return `${dateStamp}_${safeFilename}__${shortId}`;
}

/**
 * Canonical filename stem for a note. Uses `ingestedAt` since notes
 * don't have the recording-style `startTime` field; otherwise mirrors
 * the recording naming convention so vault tooling can pattern-match
 * either kind the same way.
 */
export function buildNoteBaseName(
  d: Pick<NoteDetail, "id" | "filename" | "ingestedAt">,
): string {
  const dateStamp = new Date(d.ingestedAt).toISOString().slice(0, 10);
  const safeFilename = sanitizeForFs(d.filename) || "note";
  const shortId = d.id.slice(0, 8);
  return `${dateStamp}_${safeFilename}__${shortId}`;
}

/**
 * Compose the markdown body for a single note. Mirrors the recording
 * `composeMarkdown` shape (YAML → title → body → summaries → footer)
 * minus the audio embed and transcript section. Exported so unit tests
 * can pin the layout without spinning up an Obsidian Vault.
 *
 * `recognizedText` is null when the server hasn't finished recognition
 * yet (recognizedPages is empty until status flips to ready); we write
 * a "_recognition pending_" stub so the file shows up in the vault and
 * updates on the next pass once recognition lands.
 *
 * `summaries` carries the summary metadata + full bodies inline from
 * the detail response. Empty list → "_summary pending_" stub, matching
 * the recording-side wording.
 */
export function composeNoteMarkdown(
  d: NoteDetail,
  recognizedText: string | null,
  summaries: Summary[],
): string {
  const yamlLines = [
    "---",
    `rovenotes_id: ${d.id}`,
    `rovenotes_url: ${ROVENOTES_SERVER_URL}/notes/${d.id}`,
    `rovenotes_writer_version: ${NOTE_WRITER_VERSION}`,
    // Source is always "boox" today — the handwriting recognition
    // pipeline is the only producer of notes in this surface. Pinned
    // as a constant so the YAML frontmatter shape (and any Dataview
    // query users built on it) stays stable through future source
    // additions; the field will be unpinned when a second source ships.
    `source: boox`,
    `filename: ${yamlEscape(d.filename)}`,
    `ingested_at: ${new Date(d.ingestedAt).toISOString()}`,
    // `updated_at` is the freshness anchor the sync layer reads to
    // decide whether the note row on the server has changed since the
    // last write — quoted as ISO so a YAML parser doesn't reinterpret
    // it; the index parser handles both strings and Date instances.
    `updated_at: ${new Date(d.updatedAt).toISOString()}`,
    `recognition_status: ${d.recognitionStatus}`,
  ];
  if (d.pageCount !== null) yamlLines.push(`page_count: ${d.pageCount}`);
  if (d.recognizedAt !== null) {
    yamlLines.push(`recognized_at: ${new Date(d.recognizedAt).toISOString()}`);
  }
  yamlLines.push("---", "");
  const yaml = yamlLines.join("\n");

  const title = `# ${d.filename}`;

  const recognizedSection =
    recognizedText && recognizedText.trim()
      ? recognizedText.trim()
      : d.recognitionStatus === "failed"
        ? "_recognition failed_"
        : "_recognition pending_";

  const summarySection =
    summaries.length > 0
      ? summaries
          .map((s) => {
            const label = s.tabName ?? s.title ?? "Summary";
            return `## ${label}\n\n${(s.contentText ?? "").trim()}`;
          })
          .join("\n\n")
      : "## Summary\n\n_summary pending_";

  const footer = `[Open in RoveNotes](${ROVENOTES_SERVER_URL}/notes/${d.id})`;

  return [yaml, title, "", recognizedSection, "", summarySection, "", footer, ""].join("\n");
}

/** Make a string safe for a filesystem path — mirrors the server's approach. */
function sanitizeForFs(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|\r\n\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, 100) || "recording"
  );
}

/** Single-line YAML string escape — wraps in double quotes if needed. */
function yamlEscape(s: string): string {
  if (/[:#[\]{}&*!|>'"%@`]|^[-?]|\s\s/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }
  return s;
}
