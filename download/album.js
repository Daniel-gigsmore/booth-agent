import { POLL_MS, SLIDE_MS, albumFileName, manifestIds, manifestUrl, newIds, nextSlide, parseAlbumLink, photoUrl } from "./album-logic.js";
import { sharePhoto } from "./share.js";

const $ = (id) => document.getElementById(id);
const show = (state) => { document.body.dataset.state = state; };
const link = parseAlbumLink(location.search);

let order = []; // every photo id, in taken order
let queue = []; // photos that arrived while the page was open; the slideshow plays these next
let loaded = false; // a manifest has been read at least once

// --- The list of photos ---------------------------------------------------

async function poll() {
  try {
    const res = await fetch(manifestUrl(link, Date.now()), { cache: "no-store", signal: AbortSignal.timeout?.(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = manifestIds(await res.json());
    const added = newIds(order, ids);
    if (loaded && document.body.classList.contains("playing")) queue.push(...added);
    order = ids;
    loaded = true;
    for (const id of added) $("grid").append(thumb(id));
    show(order.length > 0 ? "ready" : "empty");
    // A slideshow started before the first photos arrived shouldn't sit on a blank screen until its next tick.
    if (document.body.classList.contains("playing") && current === null && order.length > 0) advance();
  } catch {
    // Not written yet, or the network blinked: keep whatever is showing (and playing).
    if (!loaded) show("missing");
  }
  setTimeout(poll, POLL_MS);
}

function thumb(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumb";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = "Photo";
  img.src = photoUrl(link, id);
  button.append(img);
  button.addEventListener("click", () => void openViewer(order.indexOf(id)));
  return button;
}

// --- One photo, with Save / Share -----------------------------------------

let viewing = -1;
let viewerFile = null;
let viewerUrl = null;

async function openViewer(index) {
  if (index < 0 || index >= order.length) return;
  viewing = index;
  const id = order[index];
  viewerFile = null;
  $("save").disabled = true;
  if (!$("viewer").open) $("viewer").showModal();
  try {
    // Loaded as a blob up front so Save / Share can hand it straight to the share sheet:
    // iOS only allows sharing right after the tap, not after a download.
    const res = await fetch(photoUrl(link, id), { signal: AbortSignal.timeout?.(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (order[viewing] !== id) return; // moved on meanwhile
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(blob);
    $("viewer-photo").src = viewerUrl;
    viewerFile = new File([blob], albumFileName(link, id), { type: "image/jpeg" });
    $("save").disabled = false;
  } catch {
    // Show it straight from the network; Save stays off.
    if (order[viewing] === id) $("viewer-photo").src = photoUrl(link, id);
  }
}

function step(delta) {
  if (order.length > 0) void openViewer((viewing + delta + order.length) % order.length);
}

async function save() {
  if (!viewerFile) return;
  $("save").disabled = true;
  try {
    await sharePhoto(viewerFile);
  } finally {
    $("save").disabled = false;
  }
}

// --- Slideshow ------------------------------------------------------------

let current = null;
let front = 0; // which of #slide-a / #slide-b is showing
let slideTimer;
let idleTimer;

function play() {
  if (document.body.classList.contains("playing")) return;
  document.body.classList.add("playing");
  // Only works from a tap; with play=1 the screen's kiosk-mode browser is already full screen.
  document.documentElement.requestFullscreen?.().catch(() => {});
  wake();
  advance();
}

function stop() {
  document.body.classList.remove("playing");
  clearTimeout(slideTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function advance() {
  clearTimeout(slideTimer);
  if (!document.body.classList.contains("playing")) return;
  ({ current, queue } = nextSlide(order, queue, current));
  if (!current) {
    slideTimer = setTimeout(advance, SLIDE_MS); // nothing to show yet
    return;
  }
  const slides = [$("slide-a"), $("slide-b")];
  const next = slides[1 - front];
  const reveal = () => {
    if (!document.body.classList.contains("playing")) return;
    next.classList.add("on");
    slides[front].classList.remove("on");
    front = 1 - front;
    slideTimer = setTimeout(advance, SLIDE_MS);
  };
  const url = new URL(photoUrl(link, current), location.href).href;
  if (next.src === url && next.complete && next.naturalWidth > 0) {
    reveal(); // already loaded: an album of one or two photos
    return;
  }
  next.onload = reveal;
  next.onerror = () => { slideTimer = setTimeout(advance, 1000); }; // skip it; it comes round again next loop
  next.src = url;
}

function wake() {
  $("show").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $("show").classList.add("idle"), 3000);
}

if (!link) {
  show("invalid");
} else {
  if (link.name) {
    $("event-name").textContent = link.name;
    document.title = `${link.name} · Kachak album`;
  }
  $("play").addEventListener("click", play);
  $("show").addEventListener("click", stop);
  $("show").addEventListener("mousemove", wake);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") stop(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) stop(); });
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  $("close").addEventListener("click", () => $("viewer").close());
  $("save").addEventListener("click", () => void save());
  if (link.play) play();
  void poll();
}
