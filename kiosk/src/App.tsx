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

  useEffect(() => {
    if (screen.name === "attract") return;
    let timer = setTimeout(attract, IDLE_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(attract, IDLE_MS);
    };
    addEventListener("pointerdown", bump);
    return () => {
      clearTimeout(timer);
      removeEventListener("pointerdown", bump);
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
    try {
      await agent.composite(captureIds, session.template);
      setScreen({ name: "review", session, captureId: captureIds[0]! });
    } catch {
      setScreen({ name: "oops", hint: "We couldn't put your photos together. Please try again." });
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
        />
      );
    case "review":
      return (
        <Review
          template={screen.session.template}
          captureId={screen.captureId}
          onApprove={() => print(screen.session.template, screen.captureId)}
          onRetake={start}
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
      return <Oops hint={screen.hint} onRetry={start} />;
    case "operator":
      return <Operator onBack={attract} />;
  }
}
