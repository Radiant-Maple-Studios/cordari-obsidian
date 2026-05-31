import { requestUrl, type RequestUrlParam } from "obsidian";
import {
  type DeviceCodeResponse,
  type NoteDetailResponse,
  type NoteRecognizedResponse,
  type NoteSummary,
  type NotesListResponse,
  type RecordingDetailResponse,
  type RecordingsListResponse,
  type TokenPollResponse,
} from "./types.js";

/**
 * Thin wrapper around Obsidian's `requestUrl`. Using requestUrl instead of
 * the browser `fetch` is important: it runs through Electron's main
 * process so our CORS restrictions on the Cordari API don't apply. A
 * plain fetch from the renderer would carry an `Origin: app://obsidian.md`
 * header that the server's CORS allowlist rejects.
 *
 * Non-2xx responses throw ApiError so callers can distinguish 401
 * (re-link needed) from transient network errors.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown = null,
  ) {
    super(message);
  }
}

interface JsonCall {
  url: string;
  method?: string;
  body?: unknown;
  token?: string;
}

async function jsonFetch<T>(call: JsonCall): Promise<T> {
  const req: RequestUrlParam = {
    url: call.url,
    method: call.method ?? "GET",
    // `throw: false` lets us branch on status instead of catching — matches
    // the old fetch() semantics we used to build ApiError from.
    throw: false,
  };
  const headers: Record<string, string> = { accept: "application/json" };
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
    req.body = JSON.stringify(call.body);
  }
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  req.headers = headers;

  const res = await requestUrl(req);
  if (res.status < 200 || res.status >= 300) {
    let parsed: unknown = null;
    const text = res.text ?? "";
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
    }
    throw new ApiError(text || `HTTP ${res.status}`, res.status, parsed);
  }
  return res.json as T;
}

export const CORDARI_SERVER_URL = "https://app.cordari.ai";

export function createClient(token: string | null) {
  const base = CORDARI_SERVER_URL;
  return {
    startDeviceCode(clientName: string): Promise<DeviceCodeResponse> {
      return jsonFetch<DeviceCodeResponse>({
        url: `${base}/api/device/code`,
        method: "POST",
        body: { scope: "obsidian", clientName },
      });
    },
    /** Poll the token endpoint. Returns { error: "authorization_pending" } until approved. */
    pollDeviceToken(deviceCode: string, clientName: string): Promise<TokenPollResponse> {
      return jsonFetch<TokenPollResponse>({
        url: `${base}/api/device/token`,
        method: "POST",
        body: { device_code: deviceCode, client_name: clientName },
      }).catch((err) => {
        // /token intentionally returns 400 for authorization_pending + expired_token;
        // surface those to the caller as data, not exceptions.
        if (err instanceof ApiError && err.status === 400) {
          const body = err.body as { error?: string } | null;
          if (body?.error) return { error: body.error as TokenPollResponse["error"] };
        }
        throw err;
      });
    },
    listRecordings(params: { limit?: number; offset?: number; search?: string } = {}): Promise<RecordingsListResponse> {
      if (!token) throw new ApiError("not linked", 401);
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.offset) qs.set("offset", String(params.offset));
      if (params.search) qs.set("search", params.search);
      const suffix = qs.toString();
      return jsonFetch<RecordingsListResponse>({
        url: `${base}/api/recordings${suffix ? `?${suffix}` : ""}`,
        token,
      });
    },
    recordingDetail(id: string): Promise<RecordingDetailResponse> {
      if (!token) throw new ApiError("not linked", 401);
      return jsonFetch<RecordingDetailResponse>({
        url: `${base}/api/recordings/${id}`,
        token,
      });
    },
    // ---- Notes (handwritten / Boox) — /api/v1/notes/* ----
    //
    // The notes endpoints live under the versioned `/api/v1` prefix
    // (the older recordings endpoints above are unversioned for
    // backwards compatibility with prior plugin builds; the v1
    // recordings surface mirrors them). Same auth model — Bearer
    // cdr_ token.
    listNotes(params: { limit?: number; offset?: number; search?: string } = {}): Promise<NotesListResponse> {
      if (!token) throw new ApiError("not linked", 401);
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.offset) qs.set("offset", String(params.offset));
      if (params.search) qs.set("search", params.search);
      const suffix = qs.toString();
      return jsonFetch<NotesListResponse>({
        url: `${base}/api/v1/notes${suffix ? `?${suffix}` : ""}`,
        token,
      });
    },
    noteDetail(id: string): Promise<NoteDetailResponse> {
      if (!token) throw new ApiError("not linked", 401);
      return jsonFetch<NoteDetailResponse>({
        url: `${base}/api/v1/notes/${id}`,
        token,
      });
    },
    /** Returns null when recognition isn't ready yet (server 404s those). */
    noteRecognized(id: string): Promise<NoteRecognizedResponse | null> {
      if (!token) throw new ApiError("not linked", 401);
      return jsonFetch<NoteRecognizedResponse>({
        url: `${base}/api/v1/notes/${id}/recognized`,
        token,
      }).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      });
    },
    /** One summary's full body. Returns null on 404 (race with deletion). */
    noteSummary(noteId: string, assetId: string): Promise<NoteSummary | null> {
      if (!token) throw new ApiError("not linked", 401);
      return jsonFetch<NoteSummary>({
        url: `${base}/api/v1/notes/${noteId}/summaries/${encodeURIComponent(assetId)}`,
        token,
      }).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      });
    },
    async downloadBinary(url: string): Promise<ArrayBuffer> {
      const res = await requestUrl({ url, method: "GET", throw: false });
      if (res.status < 200 || res.status >= 300) {
        throw new ApiError(`download failed: ${res.status}`, res.status);
      }
      return res.arrayBuffer;
    },
  };
}

export type ApiClient = ReturnType<typeof createClient>;
