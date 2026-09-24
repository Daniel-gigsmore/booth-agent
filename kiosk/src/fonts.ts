import { useEffect, useState } from "react";
import { agent, agentUrl, BundledFont } from "./agent";

// Prefixed so a layout font never clashes with the kiosk's own UI fonts.
export const cssFamily = (family: string) => `"Layout ${family}", sans-serif`;

let loading: Promise<BundledFont[]> | null = null;

/** Registers booth-agent's bundled fonts once, so the editor draws text with the same files the print uses. */
function loadFonts(): Promise<BundledFont[]> {
  loading ??= agent.fonts().then((list) => {
    for (const f of list) {
      // One weight range per file: variable fonts cover it, and a single-weight
      // font is then used as-is for bold too, as booth-agent's renderer does.
      const face = new FontFace(`Layout ${f.family}`, `url(${agentUrl(`/fonts/${f.file}`)})`, { weight: "100 900" });
      document.fonts.add(face);
      face.load().catch(() => {});
    }
    return list;
  });
  loading.catch(() => {
    loading = null; // try again next time the editor opens
  });
  return loading;
}

export function useAgentFonts(): BundledFont[] {
  const [fonts, setFonts] = useState<BundledFont[]>([]);
  useEffect(() => {
    let live = true;
    loadFonts().then((list) => live && setFonts(list), () => {});
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}
