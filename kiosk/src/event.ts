// The active event comes from booth-agent (/health), so switching events never needs a rebuild.
import { createContext, useContext } from "react";
import type { KioskEvent } from "./downloadUrl";

export type { KioskEvent } from "./downloadUrl";
export { fillDownloadUrl, namesFixedEvent } from "./downloadUrl";

/** Provided by App from /health; null until the agent first answers. */
export const EventContext = createContext<KioskEvent | null>(null);

export const useEvent = () => useContext(EventContext);
