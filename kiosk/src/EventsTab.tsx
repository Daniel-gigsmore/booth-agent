import { useEffect, useState } from "react";
import { agent, EventRow } from "./agent";

/** Today on this PC as YYYY-MM-DD, the default date for a new event. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pick the event the booth is working, or start a new one. Photos, the layout settings and the
 * album link all follow it. After a change the kiosk reloads, so every screen (and the attract
 * slideshow's cached prints) starts over on the new event.
 */
export default function EventsTab() {
  const [list, setList] = useState<{ activeId: string; events: EventRow[] } | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    agent.events().then(setList, (e: Error) => setError(e.message));
  }, []);

  async function change(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="col gap-36">
      <div className="col gap-20">
        <div className="display fs-36">New event</div>
        <div className="row gap-20">
          <input className="text-input event-name" placeholder="Event name" value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} />
          <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="btn primary sm" disabled={busy || !name.trim() || !date}
            onClick={() => change(() => agent.createEvent(name.trim(), date))}>
            Create and switch
          </button>
        </div>
      </div>
      {error && <div className="banner error fs-24">{error}</div>}
      <div className="col gap-20">
        <div className="display fs-36">Events</div>
        {!list ? (
          <div className="muted fs-24">Loading…</div>
        ) : (
          list.events.map((e) => (
            <div key={e.id} className="row between event-row">
              <div className="col gap-6">
                <div className="fs-32">{e.name}</div>
                <div className="muted fs-24">{e.date} · {e.photoCount} photo{e.photoCount === 1 ? "" : "s"}</div>
              </div>
              {e.id === list.activeId ? (
                <div className="pill">In use</div>
              ) : (
                <button type="button" className="btn outline sm" disabled={busy}
                  onClick={() => change(() => agent.activateEvent(e.id))}>
                  Switch
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
