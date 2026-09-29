import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { AlbumStatus } from "../src/album/albumPublisher";

function report(album?: AlbumStatus) {
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
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
    ...(album ? { album } : {}),
  };
  return buildHealthReport(inputs);
}

const albumAlerts = (r: ReturnType<typeof report>) => r.alerts.filter((a) => a.code === "album-write-failed");

describe("/health album", () => {
  it("reports the album as off when there is none", () => {
    expect(report().album).toEqual({ enabled: false, photoCount: null, lastWrittenAt: null, lastError: null });
  });

  it("passes the album status through", () => {
    const album = { enabled: true, photoCount: 42, lastWrittenAt: "2026-09-29T10:00:00.000Z", lastError: null };
    expect(report(album).album).toEqual(album);
    expect(albumAlerts(report(album))).toEqual([]);
  });

  it("warns while the manifest can't be written", () => {
    const r = report({ enabled: true, photoCount: 3, lastWrittenAt: null, lastError: "album upload failed: offline" });
    expect(albumAlerts(r)).toEqual([
      expect.objectContaining({ level: "warn", code: "album-write-failed" }),
    ]);
    expect(albumAlerts(r)[0].message).toContain("album upload failed: offline");
  });
});
