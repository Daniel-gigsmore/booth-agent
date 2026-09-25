import { useEffect, useState } from "react";
import { agent, Session, Template } from "./agent";
import { useHealth } from "./hooks";
import { Attract, Done, GetReady, Oops, Printing, Review } from "./screens";
import Operator from "./Operator";

type Screen =
  | { name: "attract" }
  | { name: "getready"; session: Session }
  | { name: "review"; session: Session; captureId: string }
  | { name: "printing"; template: Template; captureId: string; waitMs: number | null }
  | { name: "done"; captureId: string }
  | { name: "oops"; hint?: string }
  | { name: "operator" };

/** No touch for this long on any screen but Attract sends the booth back to Attract. */
const IDLE_MS = 60_000;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "attract" });
  const health = useHealth(15_000);
  const attract = () => setScreen({ name: "attract" });
  useEffect(() => { const h = location.hash; if (h === "#oops") setScreen({ name: "oops" }); else if (h) agent.session().then((s) => setScreen(h === "#review" ? { name: "review", session: s, captureId: "e9c1cf15-5b37-4b3b-8573-d076892f4b0c" } : { name: "getready", session: { ...s, firstCountdownSeconds: 9999 } })); }, []);

  useEffect(() => {
    if (screen.name === "attract") return;
    // While an OS dialog (e.g. the file picker) is open, the page gets no pointer/key
    // events at all; firing Attract underneath it would kick the operator out mid-task,
    // so re-arm instead of expiring whenever the document doesn't have focus.
    const expire = () => (document.hasFocus() ? attract() : (timer = setTimeout(expire, IDLE_MS)));
    let timer = setTimeout(expire, IDLE_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, IDLE_MS);
    };
    addEventListener("pointerdown", bump);
    addEventListener("keydown", bump);
    return () => {
      clearTimeout(timer);
      removeEventListener("pointerdown", bump);
      removeEventListener("keydown", bump);
    };
  }, [screen]);

  // Settings are read fresh for every guest, so an operator's change applies to the next one.
  async function start() {
    try {
      setScreen({ name: "getready", session: await agent.session() });
    } catch {
      setScreen({ name: "oops", hint: "The booth isn't set up yet. Please ask the booth attendant." });
    }
  }

  async function composite(session: Session, captureIds: string[]) {
    // Only move on if the guest is still on this session - they may have tapped ✕ while it composed.
    const stillHere = (next: Screen) => (s: Screen) => (s.name === "getready" && s.session === session ? next : s);
    try {
      await agent.composite(captureIds, session.template);
      setScreen(stillHere({ name: "review", session, captureId: captureIds[0]! }));
    } catch {
      setScreen(stillHere({ name: "oops", hint: "We couldn't put your photos together. Please try again." }));
    }
  }

  async function print(template: Template, captureId: string) {
    setScreen({ name: "printing", template, captureId, waitMs: null });
    try {
      const job = await agent.print(captureId, template.printSize);
      setScreen((s) =>
        s.name === "printing" && s.captureId === captureId ? { ...s, waitMs: job.estimatedWaitMs } : s,
      );
    } catch {
      setScreen({ name: "oops", hint: "The printer hit a snag. Try again, or ask the booth attendant." });
    }
  }

  switch (screen.name) {
    case "attract":
      return <Attract health={health} onStart={start} onOperator={() => setScreen({ name: "operator" })} />;
    case "getready":
      return (
        <GetReady
          session={screen.session}
          onDone={(ids) => composite(screen.session, ids)}
          onFail={() => setScreen({ name: "oops" })}
          onCancel={attract}
        />
      );
    case "review":
      return (
        <Review
          template={screen.session.template}
          captureId={screen.captureId}
          onApprove={() => print(screen.session.template, screen.captureId)}
          onRetake={start}
          onCancel={attract}
        />
      );
    case "printing":
      return (
        <Printing
          template={screen.template}
          captureId={screen.captureId}
          waitMs={screen.waitMs}
          onContinue={() => setScreen({ name: "done", captureId: screen.captureId })}
        />
      );
    case "done":
      return <Done captureId={screen.captureId} onFinish={attract} />;
    case "oops":
      return <Oops hint={screen.hint} onRetry={start} onCancel={attract} />;
    case "operator":
      return <Operator onBack={attract} />;
  }
}
