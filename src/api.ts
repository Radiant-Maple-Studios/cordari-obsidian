import { requestUrl, type RequestUrlParam } from "obsidian";
import {
  type DeviceCodeResponse,
  type NoteDetailResponse,
  type NotesListResponse,
  type RecordingDetailResponse,
  type RecordingsListResponse,
  type TokenPollResponse,
} from "./types.js";

/**
 * Thin wrapper around Obsidian's `requestUrl`. Using requestUrl instead of
 * the browser `fetch` is important: it runs through Electron's main
 * process so our CORS restrictions on the RoveNotes API don't apply. A
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

export const ROVENOTES_SERVER_URL = "https://app.rovenotes.com";

export function createClient(token: string | null) {
  const base = ROVENOTES_SERVER_URL;
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
    // ---- Notes (handwritten / Boox) — /api/boox-notes/* ----
    //
    // Uses the internal /api/boox-notes surface (same one the web app
    // hits), which admits the obsidian-scoped device token via
    // requireAuth — parallel to /api/recordings above. The /api/v1
    // surface is a separate, Pro-gated public REST API for cdr_/cdrw_
    // tokens only and rejects this token with 401; pointing notes at
    // /api/v1 (the original COR-319 wiring) caused COR-352, where a
    // 401 from the notes lane tore down the freshly-minted connection.
    //
    // The detail endpoint returns the recognized markdown (per page)
    // and the full summary bodies inline, so the plugin only does ONE
    // request per note instead of detail + recognized + N summaries.
    listNotes(params: { limit?: number; offset?: number; search?: string } = {}): Promise<NotesListResponse> {
      if (!token) throw new ApiError("not linked", 401);
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.offset) qs.set("offset", String(params.offset));
      if (params.search) qs.set("search", params.search);
      const suffix = qs.toString();
      return jsonFetch<NotesListResponse>({
        url: `${base}/api/boox-notes${suffix ? `?${suffix}` : ""}`,
        token,
      });
    },
    noteDetail(id: string): Promise<NoteDetailResponse> {
      if (!token) throw new ApiError("not linked", 401);
      return jsonFetch<NoteDetailResponse>({
        url: `${base}/api/boox-notes/${id}`,
        token,
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
