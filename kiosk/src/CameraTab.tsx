import { useEffect, useState } from "react";
import { agent, agentUrl, CameraSettings, SettingKey } from "./agent";

const LABELS: Record<SettingKey, string> = {
  iso: "ISO", av: "Aperture", tv: "Shutter speed", wb: "White balance", ev: "Exposure compensation", quality: "Image quality",
};
const KEYS = Object.keys(LABELS) as SettingKey[];

/** Operator camera controls: only values the camera accepts right now, a test shot, and saved settings. */
export default function CameraTab() {
  const [s, setS] = useState<CameraSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

  const load = () => agent.cameraSettings().then((r) => { setS(r); setError(""); }, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
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
      const r = await agent.setCameraSettings({ [key]: code });
      setS(r);
      setError(r.rejected.length ? `The camera refused: ${r.rejected.map((k) => LABELS[k]).join(", ")}` : "");
    });

  return (
    <div className="row gap-40 camera-tab">
      <div className="col gap-20">
        <img className="camera-live" src={agentUrl("/liveview")} alt="Live view" />
        {shot && <img className="camera-live" src={shot} alt="Test shot" />}
        <div className="row gap-20">
          <button type="button" className="btn primary sm" disabled={busy}
            onClick={() => run(async () => setShot(URL.createObjectURL(await agent.testShot())))}>Test shot</button>
          <button type="button" className="btn outline sm" disabled={busy}
            onClick={() => run(async () => { await agent.resetCameraSettings(); await load(); })}>Use camera's current settings</button>
        </div>
      </div>
      <div className="col gap-24 grow">
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
