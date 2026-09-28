import { useEffect, useState } from "react";
import { agent, agentUrl, CameraPairing, CameraSettings, CameraSlot, Health, SettingKey } from "./agent";
import { hasLowSlot, pairingText, SLOT_NAME } from "./cameras";
import { useHealth } from "./hooks";
import { CAMERA_ARROW } from "./layout";

const LABELS: Record<SettingKey, string> = {
  iso: "ISO", av: "Aperture", tv: "Shutter speed", wb: "White balance", ev: "Exposure compensation", quality: "Image quality",
};
const KEYS = Object.keys(LABELS) as SettingKey[];

/**
 * One camera's controls: only values the camera accepts right now, a test shot, and saved settings.
 * `compact` stacks it into one column for the two-camera view. `offline` hides the live view, because
 * the agent would otherwise stream the other camera (live view follows the capture's fallback).
 */
function CameraPanel({ slot, compact, offline }: { slot: CameraSlot; compact: boolean; offline: boolean }) {
  const [s, setS] = useState<CameraSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotSource, setShotSource] = useState<string | null>(null);

  const load = () => agent.cameraSettings(slot).then((r) => { setS(r); setError(""); }, (e: Error) => setError(e.message));
  // Reload when the camera comes back (after a Swap/Remember restart or a replug).
  useEffect(() => { void load(); }, [slot, offline]);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot); }, [shot]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const change = (key: SettingKey, code: number) =>
    run(async () => {
      const r = await agent.setCameraSettings({ [key]: code }, slot);
      setS(r);
      setError(r.rejected.length ? `The camera refused: ${r.rejected.map((k) => LABELS[k]).join(", ")}` : "");
    });

  return (
    <div className={compact ? "col gap-24" : "row gap-40 camera-tab"}>
      <div className="col gap-20">
        {offline
          ? <div className="camera-live camera-off">Not connected</div>
          : <img className="camera-live" src={agentUrl(`/liveview?camera=${slot}`)} alt="Live view" />}
        {shot && <img className="camera-live" src={shot} alt="Test shot" />}
        {shot && shotSource !== "canon" && (
          <div className="banner warn fs-24">
            This test shot came from the webcam (the Canon did not take it) - it does not show the Canon's settings.
          </div>
        )}
        <div className="row gap-20">
          <button type="button" className="btn primary sm" disabled={busy}
            onClick={() => run(async () => {
              const { blob, source } = await agent.testShot(slot);
              setShot(URL.createObjectURL(blob));
              setShotSource(source);
              setError("");
            })}>Test shot</button>
          <button type="button" className="btn outline sm" disabled={busy}
            onClick={() => run(async () => { await agent.resetCameraSettings(slot); await load(); })}>Use camera's current settings</button>
        </div>
      </div>
      <div className={compact ? "camera-settings-grid" : "col gap-24 grow"}>
        {error && <div className="banner error fs-24">{error}</div>}
        {s && <div className="muted fs-24">Mode dial: {s.mode ?? "unknown"}</div>}
        {s && KEYS.map((key) => {
          const f = s.settings[key];
          const current = f.value;
          return (
            <label key={key} className="col gap-6">
              <span className="op-label">{LABELS[key]}</span>
              <select className="text-input" disabled={busy || f.options.length === 0}
                value={current?.code ?? ""} onChange={(e) => void change(key, Number(e.target.value))}>
                {!current && <option value="">–</option>}
                {current && !f.options.some((o) => o.code === current.code) && <option value={current.code}>{current.label}</option>}
                {f.options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
              {f.options.length === 0 && <span className="muted fs-20">Set by the camera in this mode</span>}
              {s.saved[key] !== undefined && <span className="muted fs-20">Saved - re-applied when the camera reconnects</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** One camera as today; with a low slot (EDSDK), High and Low side by side plus the pairing controls. */
export default function CameraTab() {
  const polled = useHealth(5_000);
  // Keep the last answer, so one missed poll doesn't tear down the two-camera view.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { if (polled) setHealth(polled); }, [polled]);
  const [pairing, setPairing] = useState<CameraPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPairing = () => agent.cameras().then(setPairing, (e: Error) => setError(e.message));
  useEffect(() => { void loadPairing(); }, []);

  if (!hasLowSlot(health)) return <CameraPanel slot="high" compact={false} offline={false} />;

  const pair = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
      setError("");
      await loadPairing();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col gap-24">
      <div className="row gap-20">
        <div className="fs-24 grow">{pairing ? pairingText(pairing) : "…"}</div>
        <button type="button" className="btn outline sm" disabled={busy} onClick={pair(agent.swapCameras)}>Swap</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={pair(agent.rememberCameras)}>Remember</button>
      </div>
      {error && <div className="banner error fs-24">{error}</div>}
      <div className="camera-cols">
        {(["high", "low"] as const).map((slot) => {
          const c = health?.cameras[slot];
          return (
            <div key={slot} className="col gap-20">
              <div className="display fs-36">{SLOT_NAME[slot]} {CAMERA_ARROW[slot]}</div>
              <div className="muted fs-24">
                {c?.connected ? `${c.model ?? "Canon"} · serial ${c.serial ?? "unknown"}` : "Not connected"}
              </div>
              <CameraPanel slot={slot} compact offline={!c?.connected} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
