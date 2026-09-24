import { useEffect, useRef, useState } from "react";
import { agent, Health } from "./agent";

/** Counts down once a second from `from`, calls onZero when it hits 0. */
export function useCountdown(from: number, onZero: () => void) {
  const [n, setN] = useState(from);
  const cb = useRef(onZero);
  cb.current = onZero;
  useEffect(() => {
    if (n <= 0) {
      cb.current();
      return;
    }
    const t = setTimeout(() => setN(n - 1), 1000);
    return () => clearTimeout(t);
  }, [n]);
  return n;
}

/** Polls /health. null = agent unreachable (or not answered yet). */
export function useHealth(everyMs: number) {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const load = () => agent.health().then(setHealth, () => setHealth(null));
    load();
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return health;
}
