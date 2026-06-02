// Shapes mirrored from the RoveNotes server. The plugin bundle is a single
// CommonJS file sent to users, so we can't depend on the server's shared
// package at build time — copy the subset we use.

export interface RecordingsListResponse {
  items: RecordingRow[];
  total: number;
  totalBytes: number;
}

export interface RecordingRow {
  id: string;
  userId: string;
  filename: string;
  /** epoch ms */
  startTime: number;
  /** epoch ms */
  endTime: number;
  durationMs: number;
  filesizeBytes: number;
  serialNumber: string;
  folder: string;
  audioPath: string | null;
  audioDownloadedAt: number | null;
  /** epoch ms — sort key for incremental polling. */
  ingestedAt: number;
  isHistorical: boolean;
  isTrash: boolean;
  lastError: string | null;
  hasTranscript: boolean;
  summaryCount: number;
  status:
    | "historical"
    | "pending_audio"
    | "pending_transcript"
    | "pending_summary"
    | "complete"
    | "error";
}

export interface Summary {
  id: string;
  source: "plaud" | "cordari";
  title: string | null;
  tabName: string | null;
  plaudTemplateId: string | null;
  contentText: string;
}

export interface RecordingDetailResponse {
  recording: RecordingDetail;
  mediaBase: string;
  audioUrl: string | null;
}

export interface RecordingDetail extends RecordingRow {
  transcriptText: string | null;
  summaries: Summary[];
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: "authorization_pending" | "expired_token" | "invalid_request" | "server_error";
}

// ---- Notes (handwritten, /api/boox-notes) ----
//
// Mirrored from cordari-cloud's `routes/boox-notes.ts` + the
// `BooxNote*` types in `shared/src/note.ts`. The plugin talks to the
// internal /api/boox-notes surface (not /api/v1/notes — that one is
// Pro-gated to cdr_/cdrw_ public-API tokens and rejects the
// obsidian-scoped device token with 401).

export type NoteRecognitionStatus =
  | "pending"
  | "in_progress"
  | "ready"
  | "failed"
  | (string & {});

/** One row in the GET /api/boox-notes list response. */
export interface NoteRow {
  id: string;
  /** WebDAV path the device sent, e.g. "/Notebooks/Daily.pdf". */
  sourcePath: string;
  /** Display filename derived from sourcePath. */
  filename: string;
  filesizeBytes: number;
  contentType: string;
  /** epoch ms — sort key for incremental polling. */
  ingestedAt: number;
  /** epoch ms — bumped on every re-PUT of the same path. */
  updatedAt: number;
  pageCount: number | null;
  recognitionStatus: NoteRecognitionStatus;
  recognitionError: string | null;
  /** epoch ms */
  recognizedAt: number | null;
  /** Number of RoveNotes summary assets persisted for this note. */
  summaryAssetCount: number;
}

export interface NotesListResponse {
  total: number;
  totalBytes: number;
  items: NoteRow[];
}

/** One page of recognized markdown from the bundled detail. */
export interface RecognizedPage {
  pageNumber: number;
  contentText: string;
}

/**
 * Inner detail row returned under `note` by GET /api/boox-notes/:id.
 * Carries everything the writer needs (frontmatter fields +
 * recognizedPages + summaries with contentText) in a single fetch.
 * The full server response also includes `tags`, `actionItems`, and
 * `calendarEvents`; the plugin doesn't use those today but they
 * arrive on the wire and are passed through as opaque arrays.
 */
export interface NoteDetail extends NoteRow {
  recognizedPages: RecognizedPage[];
  summaries: Summary[];
  tags: unknown[];
  actionItems: unknown[];
  calendarEvents: unknown[];
}

/**
 * Top-level wrapper for GET /api/boox-notes/:id. `pdfUrl` and
 * `routedTo` are SPA-facing fields the plugin ignores, but kept on the
 * type so an upstream wire-format addition doesn't surprise the
 * compiler.
 */
export interface NoteDetailResponse {
  note: NoteDetail;
  pdfUrl: string | null;
  routedTo: unknown[];
}
