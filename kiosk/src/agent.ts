// Thin client for booth-agent (see its README "API" section). Everything the
// kiosk needs from the camera, printer and outbox goes through here.
const env = import.meta.env;
const base = env.VITE_AGENT_URL || "http://127.0.0.1:7070";
const token = env.VITE_AGENT_TOKEN || "";

export const config = {
  eventName: env.VITE_EVENT_NAME || "",
  eventDate: env.VITE_EVENT_DATE || "",
  downloadUrl: (captureId: string) =>
    env.VITE_DOWNLOAD_URL ? env.VITE_DOWNLOAD_URL.replace("{captureId}", captureId) : "",
};

/** For <img src>: images can't send an Authorization header, so the agent also accepts ?token=. */
export const agentUrl = (path: string) =>
  `${base}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

async function call<T>(method: "GET" | "POST", path: string, body?: object | Blob): Promise<T> {
  const isBlob = body instanceof Blob;
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": isBlob ? body.type : "application/json" } : {}),
    },
    body: body ? (isBlob ? body : JSON.stringify(body)) : undefined,
    // A hung request would otherwise freeze the guest on a spinner forever.
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

export type HealthLevel = "ok" | "warn" | "error";

export interface Health {
  overall: HealthLevel;
  alerts: { level: "warn" | "error"; code: string; message: string }[];
  camera: { activeSource: string; model: string | null };
  printer: { reachable: boolean; ok: boolean; status: string | null; model: string | null; mediaRemaining: number | null };
  stalledPrints: { count: number };
  outbox: { queueDepth: number; lastError: string | null };
}

export type PrintSize = "4x6" | "2x6-strip";

export interface Slot { x: number; y: number; width: number; height: number }

/** A print layout. One photo per slot, so slot count = shots per guest. */
export interface Template {
  id: string;
  name?: string;
  printSize: PrintSize;
  cellWidthPx: number;
  cellHeightPx: number;
  photoSlots: Slot[];
  overlayFile: string | null;
}

export interface SessionSettings {
  templateId: string;
  firstCountdownSeconds: number;
  betweenShotsSeconds: number;
}

export interface Session extends SessionSettings {
  template: Template;
}

export interface PrintJob {
  id: string;
  capture_id: string;
  size: string;
  status: "queued" | "dropped" | "failed";
  queued_at: string;
}

export const agent = {
  capture: () => call<{ captureId: string }>("POST", "/capture"),
  /** Composite is filed under the first shot; print and reprint use that id. */
  composite: (captureIds: string[], template: Template) =>
    call("POST", "/composite", { captureId: captureIds[0], captureIds, templateId: template.id }),
  print: (captureId: string, size: PrintSize) =>
    call<{ jobId: string; estimatedWaitMs: number }>("POST", "/print", { captureId, size }),
  session: () => call<Session>("GET", "/session"),
  saveSession: (s: SessionSettings) => call<Session>("POST", "/session", s),
  templates: () => call<{ templates: Template[] }>("GET", "/templates").then((r) => r.templates),
  saveTemplate: (t: Template) => call<Template>("POST", `/templates/${t.id}`, t),
  deleteTemplate: (id: string) => call("POST", `/templates/${id}/delete`),
  uploadOverlay: (id: string, png: Blob) => call<Template>("POST", `/templates/${id}/overlay`, png),
  health: () => call<Health>("GET", "/health"),
  history: () => call<{ jobs: PrintJob[] }>("GET", "/print/history?limit=3"),
  reprint: (jobId: string) => call("POST", "/print/reprint", { jobId }),
};
