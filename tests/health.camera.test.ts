import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { CameraDetail } from "../src/camera/edsdk/protocol";

const detail = (over: Partial<CameraDetail> = {}): CameraDetail => ({
  battery: 80, mode: "M", afMode: "AI Servo", quality: { label: "JPEG", hasJpeg: true }, lastError: null, ...over,
});

function report(over: { canonDetail?: CameraDetail | null; driver?: "digicamcontrol" | "edsdk"; digiCamControlRunning?: boolean; activeSource?: string } = {}) {
  const inputs: HealthInputs = {
    camera: {
      activeSource: (over.activeSource ?? "canon") as never,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: false,
      preference: "canon",
      canonDetail: over.canonDetail === undefined ? detail() : over.canonDetail,
    },
    canon: { driver: over.driver ?? "edsdk", digiCamControlRunning: over.digiCamControlRunning ?? false },
    hotFolder: { path: "C:\\hot", writable: true },
    stalledPrints: { count: 0, oldestDroppedAt: null, oldestAgeSeconds: null, files: [] },
    printer: { reachable: true, ok: true, status: "STATUS_OK", model: "RX1HS", mediaRemaining: 500, mediaType: "4x6", serialNumber: null, lastUpdatedAt: null, staleMs: 0, error: null, statusFilePath: "x", raw: {} } as never,
    disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
  };
  return buildHealthReport(inputs);
}

const codes = (r: ReturnType<typeof report>) => r.alerts.map((a) => `${a.level}:${a.code}`);

describe("/health camera status", () => {
  it("reports the driver and the camera detail", () => {
    const r = report({ canonDetail: detail({ battery: "ac", lastError: { message: "x", at: "t" } }) });
    expect(r.camera).toMatchObject({
      driver: "edsdk", battery: "ac", mode: "M", afMode: "AI Servo",
      quality: { label: "JPEG", hasJpeg: true }, lastError: { message: "x", at: "t" },
    });
    expect(r.overall).toBe("ok");
  });

  it("has nulls with the digiCamControl driver", () => {
    const r = report({ driver: "digicamcontrol", canonDetail: null });
    expect(r.camera).toMatchObject({ driver: "digicamcontrol", battery: null, mode: null, afMode: null, quality: null, lastError: null });
  });

  it("warns on a low battery but not on AC", () => {
    expect(codes(report({ canonDetail: detail({ battery: 19 }) }))).toContain("warn:camera-battery-low");
    expect(codes(report({ canonDetail: detail({ battery: 20 }) }))).not.toContain("warn:camera-battery-low");
    expect(codes(report({ canonDetail: detail({ battery: "ac" }) }))).not.toContain("warn:camera-battery-low");
  });

  it("errors when the camera would produce no JPEG", () => {
    expect(codes(report({ canonDetail: detail({ quality: { label: "RAW", hasJpeg: false } }) }))).toContain("error:camera-raw-only");
  });

  it("errors when digiCamControl is running alongside the EDSDK driver", () => {
    expect(codes(report({ digiCamControlRunning: true }))).toContain("error:camera-digicamcontrol-conflict");
    expect(codes(report({ driver: "digicamcontrol", digiCamControlRunning: true, canonDetail: null }))).not.toContain(
      "error:camera-digicamcontrol-conflict"
    );
  });

  it("does not blame digiCamControl for a missing camera under EDSDK", () => {
    const edsdk = report({ activeSource: "none" }).alerts.find((a) => a.code === "camera-none");
    expect(edsdk?.message).not.toMatch(/digiCamControl/);
    const dcc = report({ activeSource: "none", driver: "digicamcontrol", canonDetail: null }).alerts.find((a) => a.code === "camera-none");
    expect(dcc?.message).toMatch(/digiCamControl/);
  });
});
