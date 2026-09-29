import { RETRY_MS, imageUrl, parseLink, shareFileName, waitingState } from "./photo.js";

const show = (state) => { document.body.dataset.state = state; };
const link = parseLink(location.search);
const openedAt = Date.now();
let file = null;

async function attempt() {
  try {
    const res = await fetch(imageUrl(link, Date.now()), { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    file = new File([blob], shareFileName(link), { type: "image/jpeg" });
    document.getElementById("photo").src = URL.createObjectURL(blob);
    show("ready");
  } catch {
    // Not uploaded yet (the booth syncs when it's online), or the network blinked.
    show(waitingState(Date.now() - openedAt));
    setTimeout(attempt, RETRY_MS);
  }
}

async function share() {
  if (!file) return;
  const button = document.getElementById("share");
  button.disabled = true;
  try {
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
        // Share failed for another reason: fall back to a plain download.
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } finally {
    button.disabled = false;
  }
}

if (!link) {
  show("invalid");
} else {
  if (link.name) {
    document.getElementById("event-name").textContent = link.name;
    document.title = `${link.name} · Your Kachak photo`;
  }
  document.getElementById("share").addEventListener("click", () => void share());
  void attempt();
}
