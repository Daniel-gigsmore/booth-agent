import { useEffect, useState } from "react";
import { agent, config, PrintJob, SessionSettings, Template } from "./agent";
import { useHealth } from "./hooks";
import LayoutEditor, { LayoutThumb } from "./LayoutEditor";
import { newTemplate, shotCount } from "./layout";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Card({ label, value, ok, note }: { label: string; value: string; ok: boolean; note: string }) {
  return (
    <div className="op-card">
      <div className="op-label">{label}</div>
      <div className="op-value">{value}</div>
      <div className={`op-note ${ok ? "good" : "bad"}`}><span className={`status-dot ${ok ? "ok" : "error"}`} />{note}</div>
    </div>
  );
}

function StatusTab() {
  const health = useHealth(5_000);
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [reprinting, setReprinting] = useState("");

  const loadJobs = () => agent.history().then((r) => setJobs(r.jobs), () => {});
  useEffect(() => {
    loadJobs();
    const t = setInterval(loadJobs, 5_000);
    return () => clearInterval(t);
  }, []);

  async function reprint(jobId: string) {
    setReprinting(jobId);
    await agent.reprint(jobId).catch((e: Error) => alert(`Reprint failed: ${e.message}`));
    setReprinting("");
    loadJobs();
  }

  const h = health;
  return (
    <>
      <div className={`banner ${!h ? "error" : h.overall}`}>
        {!h && <div>Can't reach booth-agent. Check the service is running on this PC.</div>}
        {h?.overall === "ok" && <div>All clear. Camera, printer and photo sync are working.</div>}
        {h?.alerts.map((a) => <div key={a.code}>{a.message}</div>)}
      </div>

      {h && (
        <div className="op-grid">
          <Card label="CAMERA" value={h.camera.model ?? h.camera.activeSource}
            ok={h.camera.activeSource !== "none"} note={h.camera.activeSource === "none" ? "No camera" : `Using ${h.camera.activeSource}`} />
          <Card label={`PRINTER${h.printer.model ? ` · ${h.printer.model}` : ""}`}
            value={h.printer.mediaRemaining !== null ? `${h.printer.mediaRemaining} prints left` : "Media unknown"}
            ok={h.printer.ok} note={h.printer.reachable ? h.printer.status ?? "Unknown" : "Not reachable"} />
          <Card label="PHOTO SYNC" value={h.outbox.queueDepth === 0 ? "Up to date" : "Uploading"}
            ok={!h.outbox.lastError} note={h.outbox.lastError ? "Offline, will retry" : `${h.outbox.queueDepth} waiting to upload`} />
          <Card label="HOT FOLDER" value={h.stalledPrints.count === 0 ? "Printing normally" : "Stuck"}
            ok={h.stalledPrints.count === 0} note={`${h.stalledPrints.count} stuck`} />
        </div>
      )}

      <div className="col gap-16">
        <div className="display fs-36">Recent prints</div>
        <div className="jobs-row head"><div>TIME</div><div>JOB</div><div>SIZE</div><div>STATUS</div><div /></div>
        {jobs.map((j) => (
          <div key={j.id} className="jobs-row">
            <div className="bold">{time(j.queued_at)}</div>
            <div className="muted">{j.id.slice(0, 8)}</div>
            <div>{j.size}</div>
            <div className={`op-note ${j.status === "failed" ? "bad" : "good"}`}>
              <span className={`status-dot ${j.status === "failed" ? "error" : "ok"}`} />
              {j.status === "dropped" ? "Sent to printer" : j.status === "queued" ? "Queued" : "Failed"}
            </div>
            <button type="button" className="btn outline row-btn" disabled={reprinting === j.id} onClick={() => reprint(j.id)}>
              {reprinting === j.id ? "…" : "Reprint"}
            </button>
          </div>
        ))}
        {jobs.length === 0 && <div className="muted fs-24">No prints yet.</div>}
      </div>
    </>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <div className="op-label">{label}</div>
      <div className="row gap-20">
        <button type="button" className="btn outline step-btn" aria-label={`${label}: less`} disabled={value <= 1}
          onClick={() => onChange(value - 1)}>−</button>
        <div className="step-value">{value}s</div>
        <button type="button" className="btn outline step-btn" aria-label={`${label}: more`} disabled={value >= 10}
          onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function SettingsTab({ onEdit }: { onEdit: (t: Template, all: Template[], inUseId: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    agent.templates().then(setTemplates, (e: Error) => setError(e.message));
    // A 409 still carries the settings (the chosen layout is missing), so fall back to defaults for the rest.
    agent.session().then(
      (s) => setSettings(s),
      () => setSettings({ templateId: "", firstCountdownSeconds: 3, betweenShotsSeconds: 3 }),
    );
  }, []);

  async function update(next: SessionSettings) {
    setSettings(next);
    setSaved(false);
    try {
      await agent.saveSession(next);
      setError("");
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const t = await agent.importLayout(JSON.parse(await file.text()));
      setTemplates(await agent.templates());
      setError("");
      setNote(`Imported "${t.name ?? t.id}".`);
    } catch (e) {
      setError(e instanceof SyntaxError ? "That file isn't a layout file." : (e as Error).message);
    }
  }

  async function exportLayout(t: Template) {
    try {
      const bundle = await agent.exportLayout(t.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${t.id}.kachak-layout.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`Exported "${t.name ?? t.id}" to Downloads.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!settings) return <div className="muted fs-28">Loading…</div>;
  return (
    <div className="settings">
      <div className="col gap-16 grow">
        <div className="row between">
          <div className="display fs-36">Layout</div>
          <div className="row gap-16">
            <label className="btn outline sm file-btn">
              Import
              <input type="file" accept=".json,application/json"
                onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button type="button" className="btn primary sm" onClick={() => onEdit(newTemplate(), templates, settings.templateId)}>
              New layout
            </button>
          </div>
        </div>
        {note && <div className="muted fs-24">{note}</div>}
        <div className="layout-list">
          {templates.map((t) => (
            <div key={t.id} className={`layout-card ${t.id === settings.templateId ? "on" : ""}`}>
              <button type="button" className="layout-pick" onClick={() => update({ ...settings, templateId: t.id })}>
                <div className="layout-thumb-box"><LayoutThumb t={t} height={150} /></div>
                <div className="col gap-6">
                  <div className="bold fs-26">{t.name ?? t.id}</div>
                  <div className="muted fs-24">
                    {shotCount(t)} photo{shotCount(t) === 1 ? "" : "s"} · {t.printSize === "4x6" ? "4R" : "2×6 strips"}
                  </div>
                  {t.id === settings.templateId && <div className="in-use">In use</div>}
                </div>
              </button>
              <div className="col gap-6">
                <button type="button" className="btn outline row-btn" onClick={() => onEdit(t, templates, settings.templateId)}>
                  Edit
                </button>
                <button type="button" className="btn outline row-btn" onClick={() => exportLayout(t)}>
                  Export
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="col gap-36 timing">
        <div className="display fs-36">Countdown</div>
        <Stepper label="FIRST PHOTO" value={settings.firstCountdownSeconds}
          onChange={(v) => update({ ...settings, firstCountdownSeconds: v })} />
        <Stepper label="BETWEEN PHOTOS" value={settings.betweenShotsSeconds}
          onChange={(v) => update({ ...settings, betweenShotsSeconds: v })} />
        {error && <div className="banner error fs-24">{error}</div>}
        {saved && !error && <div className="muted fs-24">Saved. The next guest gets these settings.</div>}
      </div>
    </div>
  );
}

export default function Operator({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<"status" | "settings">("status");
  const [editing, setEditing] = useState<{ t: Template; ids: string[]; inUseId: string } | null>(null);
  // Bumped after the editor saves, so the Settings tab reloads its list.
  const [settingsKey, setSettingsKey] = useState(0);

  return (
    <div className="stage operator">
      <div className="row between">
        <div className="col gap-6">
          <div className="display fs-64">{editing ? (editing.t.id ? "Edit layout" : "New layout") : "Operator panel"}</div>
          {config.eventName && <div className="muted fs-24">Event: {config.eventName}</div>}
        </div>
        {!editing && (
          <div className="row gap-20">
            <div className="seg">
              <button type="button" className={tab === "status" ? "on" : ""} onClick={() => setTab("status")}>Status</button>
              <button type="button" className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
            </div>
            <button type="button" className="btn outline sm" onClick={onBack}>Back to kiosk</button>
          </div>
        )}
      </div>

      {editing ? (
        <LayoutEditor
          initial={editing.t}
          takenIds={editing.ids}
          inUseId={editing.inUseId}
          onClose={(changed) => {
            setEditing(null);
            if (changed) setSettingsKey((k) => k + 1);
          }}
        />
      ) : tab === "status" ? (
        <StatusTab />
      ) : (
        <SettingsTab
          key={settingsKey}
          onEdit={(t, all, inUseId) => setEditing({ t, ids: all.map((x) => x.id), inUseId })}
        />
      )}
    </div>
  );
}
