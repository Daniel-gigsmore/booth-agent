// Thin client for booth-agent (see its README "API" section). Everything the
// kiosk needs from the camera, printer and outbox goes through here.
import { templateBody } from "./layout";

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

/** Like call(), for endpoints that answer with an image. */
async function callBlob(path: string, body: object): Promise<Blob> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `POST ${path} failed (${res.status})`);
  }
  return res.blob();
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

/** Every element is a box in cell pixels; x/y is the top-left of the unrotated box. */
interface Box { id: string; x: number; y: number; width: number; height: number; rotation: number; hidden: boolean }
export type PhotoElement = Box & { type: "photo"; shot: number };
export type ImageElement = Box & { type: "image"; file: string };
export type TextElement = Box & {
  type: "text"; text: string; font: string; size: number; color: string; align: "left" | "center" | "right"; bold: boolean;
};
export type RectElement = Box & { type: "rect"; fill: string; radius: number; opacity: number };
export type LayoutElement = PhotoElement | ImageElement | TextElement | RectElement;

/** A print layout: a background and elements in layer order (first = bottom). Each distinct photo shot is one photo per guest. */
export interface Template {
  id: string;
  name?: string;
  printSize: PrintSize;
  cellWidthPx: number;
  cellHeightPx: number;
  background: string;
  elements: LayoutElement[];
}

/** A font booth-agent bundles for text elements. */
export interface BundledFont { family: string; file: string; hasBold: boolean }

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
  saveTemplate: (t: Template) => call<Template>("POST", `/templates/${t.id}`, templateBody(t)),
  deleteTemplate: (id: string) => call("POST", `/templates/${id}/delete`),
  uploadAsset: (id: string, file: Blob) => call<{ file: string }>("POST", `/templates/${id}/assets`, file),
  fonts: () => call<{ fonts: BundledFont[] }>("GET", "/fonts").then((r) => r.fonts),
  previewLayout: (t: Template) => callBlob("/layout-preview", templateBody(t)),
  testPrintLayout: (t: Template) => call<{ jobId: string }>("POST", "/layout-preview/print", templateBody(t)),
  exportLayout: (id: string) => call<object>("GET", `/templates/${id}/export`),
  importLayout: (bundle: object) => call<Template>("POST", "/layout-import", bundle),
  copyLayout: (sourceId: string, t: Template, name: string) =>
    call<Template>("POST", `/templates/${sourceId}/copy`, { name, template: templateBody(t) }),
  health: () => call<Health>("GET", "/health"),
  history: () => call<{ jobs: PrintJob[] }>("GET", "/print/history?limit=3"),
  reprint: (jobId: string) => call("POST", "/print/reprint", { jobId }),
  /** Fire-and-forget: tells the camera a shot is ~1.5 s away. A failure never affects the countdown. */
  prefocus: () => {
    void call("POST", "/camera/prefocus").catch(() => undefined);
  },
};
