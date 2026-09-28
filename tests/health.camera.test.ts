import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { CameraDetail } from "../src/camera/edsdk/protocol";

const detail = (over: Partial<CameraDetail> = {}): CameraDetail => ({
  battery: 80, mode: "M", afMode: "AI Servo", quality: { label: "JPEG", hasJpeg: true }, lastError: null, ...over,
});

function report(
  over: {
    canonDetail?: CameraDetail | null;
    driver?: "digicamcontrol" | "edsdk";
    digiCamControlRunning?: boolean;
    activeSource?: string;
    low?: { connected: boolean; detail?: CameraDetail | null } | null;
    layoutUsesLow?: boolean;
  } = {}
) {
  const inputs: HealthInputs = {
    camera: {
      activeSource: (over.activeSource ?? "canon") as never,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: false,
      preference: "canon",
      canonDetail: over.canonDetail === undefined ? detail() : over.canonDetail,
      canonModel: "Canon EOS R100",
      canonSerial: "SN-A",
      low:
        over.low === undefined
          ? null
          : over.low && { connected: over.low.connected, model: "Canon EOS R100", serial: "SN-B", detail: over.low.detail ?? null },
    },
    canon: { driver: over.driver ?? "edsdk", digiCamControlRunning: over.digiCamControlRunning ?? false },
    hotFolder: { path: "C:\\hot", writable: true },
    stalledPrints: { count: 0, oldestDroppedAt: null, oldestAgeSeconds: null, files: [] },
    printer: { reachable: true, ok: true, status: "STATUS_OK", model: "RX1HS", mediaRemaining: 500, mediaType: "4x6", serialNumber: null, lastUpdatedAt: null, staleMs: 0, error: null, statusFilePath: "x", raw: {} } as never,
    disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
    layoutUsesLow: over.layoutUsesLow ?? false,
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

describe("/health with a low camera", () => {
  it("has no low alerts or block without a low slot", () => {
    const r = report();
    expect(r.cameras.low).toBeNull();
    expect(r.cameras.high).toMatchObject({ connected: true, serial: "SN-A" });
    expect(codes(r).some((c) => c.includes("-low"))).toBe(false);
  });

  it("a missing low camera is an error when the layout uses it, and no alert otherwise", () => {
    expect(codes(report({ low: { connected: false }, layoutUsesLow: true }))).toContain("error:camera-low-none");
    expect(codes(report({ low: { connected: false }, layoutUsesLow: false })).some((c) => c.endsWith(":camera-low-none"))).toBe(false);
    expect(codes(report({ low: { connected: true }, layoutUsesLow: true }))).not.toContain("error:camera-low-none");
  });

  it("reports the low camera's battery and RAW-only problems with a -low suffix", () => {
    const c = codes(report({ low: { connected: true, detail: detail({ battery: 10, quality: { label: "RAW", hasJpeg: false } }) } }));
    expect(c).toContain("warn:camera-battery-low-low");
    expect(c).toContain("error:camera-raw-only-low");
  });
});
