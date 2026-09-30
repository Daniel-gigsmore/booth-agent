import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { AlbumStatus } from "../src/album/albumPublisher";

function report(album?: AlbumStatus, outboxLastSyncAt: string | null = null, extra: Partial<HealthInputs> = {}) {
  const inputs: HealthInputs = {
    camera: {
      activeSource: "canon" as never,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: false,
      preference: "canon",
      canonDetail: null,
      canonModel: "Canon EOS R100",
      canonSerial: "SN-A",
      low: null,
    },
    canon: { driver: "digicamcontrol", digiCamControlRunning: true },
    hotFolder: { path: "C:\\hot", writable: true },
    stalledPrints: { count: 0, oldestDroppedAt: null, oldestAgeSeconds: null, files: [] },
    printer: { reachable: true, ok: true, status: "STATUS_OK", model: "RX1HS", mediaRemaining: 500, mediaType: "4x6", serialNumber: null, lastUpdatedAt: null, staleMs: 0, error: null, statusFilePath: "x", raw: {} } as never,
    disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: outboxLastSyncAt, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
    ...(album ? { album } : {}),
    ...extra,
  };
  return buildHealthReport(inputs);
}

const albumAlerts = (r: ReturnType<typeof report>) => r.alerts.filter((a) => a.code === "album-write-failed");

describe("/health album", () => {
  it("reports the album as off when there is none", () => {
    expect(report().album).toEqual({ enabled: false, photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null });
  });

  it("passes the album status through", () => {
    const album = { enabled: true, photoCount: 42, lastWrittenAt: "2026-09-29T10:00:00.000Z", lastError: null, failingSince: null };
    expect(report(album).album).toEqual(album);
    expect(albumAlerts(report(album))).toEqual([]);
  });

  it("warns while the manifest can't be written but uploads are working", () => {
    const r = report(
      { enabled: true, photoCount: 3, lastWrittenAt: null, lastError: "album upload failed: offline", failingSince: "2026-09-29T10:00:00.000Z" },
      "2026-09-29T10:05:00.000Z"
    );
    expect(albumAlerts(r)).toEqual([
      expect.objectContaining({ level: "warn", code: "album-write-failed" }),
    ]);
    expect(albumAlerts(r)[0].message).toContain("album upload failed: offline");
  });

  it("does not warn while offline - no upload has succeeded since the album started failing", () => {
    const failing = {
      enabled: true,
      photoCount: 3,
      lastWrittenAt: null,
      lastError: "album upload failed: offline",
      failingSince: "2026-09-29T10:00:00.000Z",
    };
    // No sync at all yet.
    expect(albumAlerts(report(failing, null))).toEqual([]);
    // Last sync predates the failing streak - stale, not evidence the network is back.
    expect(albumAlerts(report(failing, "2026-09-29T09:00:00.000Z"))).toEqual([]);
  });
});

describe("/health event", () => {
  it("reports the event's name and date, falling back to the id", () => {
    expect(report(undefined, null, { eventName: "Gigsmore Launch", eventDate: "2026-09-30" })).toMatchObject({
      eventId: "evt",
      eventName: "Gigsmore Launch",
      eventDate: "2026-09-30",
    });
    expect(report()).toMatchObject({ eventName: "evt", eventDate: null });
  });

  it("errors while events.json can't be read", () => {
    const alerts = report(undefined, null, { eventsFileError: "Unexpected token" }).alerts;
    expect(alerts).toContainEqual(expect.objectContaining({ level: "error", code: "events-file-unreadable" }));
  });
});
