import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { agent, agentUrl, config, Health, printUrl, Session, Template, type CameraSlot } from "./agent";
import { mergeAlbum, nextSlide, type SlideState } from "./album";
import { useCountdown } from "./hooks";
import { useEvent, fillDownloadUrl } from "./event";
import { shotCount, shotPrompt } from "./layout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Icon = ({ size, d, children }: { size: number; d?: string; children?: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d && <path d={d} />}
    {children}
  </svg>
);
const CheckIcon = ({ size }: { size: number }) => <Icon size={size} d="M20 6L9 17l-5-5" />;
const RetakeIcon = ({ size }: { size: number }) => (
  <Icon size={size} d="M3 12a9 9 0 1 0 3-6.7L3 8"><path d="M3 3v5h5" /></Icon>
);

/** Top-right ✕ on every guest screen that would otherwise trap them: drops the session and goes back to Attract. */
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="close-x" aria-label="Cancel and start over" onClick={onClick}>
      <Icon size={48} d="M18 6L6 18"><path d="M6 6l12 12" /></Icon>
    </button>
  );
}

const Logo = () => (
  <div className="logo"><span className="logo-dot" />KACHAK</div>
);

/** A 2x6 print strip. With a photo it shows that photo in every slot, as the strip template does. */
function Strip({ photo, className = "" }: { photo?: string; className?: string }) {
  const event = useEvent();
  return (
    <div className={`strip ${className}`}>
      {[0, 1, 2].map((i) =>
        photo ? <img key={i} className="strip-cell" src={photo} alt="" /> : <div key={i} className="strip-cell placeholder" />,
      )}
      <div className="strip-foot">
        <div className="strip-event">{event?.name}</div>
        <div className="strip-date">{event?.date}</div>
      </div>
    </div>
  );
}

const ALBUM_POLL_MS = 15_000;
const SLIDE_MS = 6_000;

// Attract unmounts for every guest, so where the slideshow is up to lives out here: coming back, it
// carries on (with the guest's own print next) instead of restarting from the oldest print.
const attract: SlideState & { on: boolean; layers: [string | null, string | null]; front: number } = {
  order: [], queue: [], current: null, loaded: false, on: false, layers: [null, null], front: 0,
};

/**
 * Whether guests get the album: prints on Attract and its "View album" button. Only when there are
 * prints and the operator hasn't switched it off (Album tab). Polls the agent, which works offline.
 */
function useGuestAlbum(): boolean {
  const [on, setOn] = useState(attract.on);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [info, ids] = await Promise.all([agent.albumInfo(), agent.albumPhotos()]);
        if (!alive) return;
        mergeAlbum(attract, ids);
        attract.on = info.attractSlideshow && ids.length > 0;
        setOn(attract.on);
      } catch {
        // Agent busy or restarting: keep whatever is showing.
      }
    };
    void load();
    const t = setInterval(load, ALBUM_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return on;
}

/**
 * This event's prints, fading one into the next where the sample strips sit, so the booth shows
 * what it makes. New prints play next. Falls back to the sample strips while guests don't get the album.
 */
function AttractPrints({ on, fallback }: { on: boolean; fallback: React.ReactNode }) {
  const [layers, setLayers] = useState(attract.layers);
  const [front, setFront] = useState(attract.front);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      ({ current: attract.current, queue: attract.queue } = nextSlide(attract.order, attract.queue, attract.current));
      if (!attract.current) {
        timer = setTimeout(step, SLIDE_MS);
        return;
      }
      // Loaded off-screen first, so the fade never shows a half-drawn print.
      const url = printUrl(attract.current);
      const img = new Image();
      img.onload = () => {
        if (!alive) return;
        const back = 1 - attract.front;
        attract.layers = back === 0 ? [url, attract.layers[1]] : [attract.layers[0], url];
        attract.front = back;
        setLayers(attract.layers);
        setFront(back);
        timer = setTimeout(step, SLIDE_MS);
      };
      img.onerror = () => {
        if (alive) timer = setTimeout(step, 1000); // skip it; it comes round again next loop
      };
      img.src = url;
    };
    step();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [on]);

  // Also the strips until a print has actually loaded (or if none will).
  if (!on || !layers[front]) return <>{fallback}</>;
  return (
    <div className="attract-prints">
      {layers.map((src, i) => src && <img key={i} className={i === front ? "on" : ""} src={src} alt="" />)}
    </div>
  );
}

export function Attract({ health, onStart, onOperator, onAlbum }: {
  health: Health | null; onStart: () => void; onOperator: () => void; onAlbum: () => void;
}) {
  const album = useGuestAlbum();
  const event = useEvent();
  return (
    <div className="stage attract" onClick={onStart}>
      <div className="attract-main">
        <Logo />
        <div className="attract-copy">
          {event?.name && <div className="pill">{event.name}</div>}
          <h1 className="display hero">Strike<br />a pose.</h1>
          <p className="lede">Tap to take your photo. Your print is ready in seconds, with a free download to your phone.</p>
        </div>
        <div className="row gap-40">
          <button type="button" className="btn primary xl">
            <Icon size={56} d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z">
              <circle cx="12" cy="13" r="3" />
            </Icon>
            Tap to start
          </button>
          <div className="muted fs-26">or touch anywhere on the screen</div>
        </div>
      </div>
      <div className="attract-strips">
        <AttractPrints on={album} fallback={<><Strip className="tilt-left" /><Strip className="tilt-right" /></>} />
        {album && (
          <button
            type="button"
            className="btn outline md attract-album-btn"
            onClick={(e) => {
              e.stopPropagation(); // not a session start
              onAlbum();
            }}
          >
            View album
          </button>
        )}
      </div>
      {/* One tap opens the operator panel. The ring shows booth-agent's health. */}
      <button
        type="button"
        className={`op-lock ${health?.overall ?? "unknown"}`}
        aria-label="Operator panel"
        onClick={(e) => {
          e.stopPropagation();
          onOperator();
        }}
      >
        <Icon size={40} d="M7 11V7a5 5 0 0 1 10 0v4">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M12 15v2" />
        </Icon>
      </button>
    </div>
  );
}

/**
 * In a burst the Canon can still be busy with the previous shot and answer
 * "Device Busy. Failed to press fully". Give it a moment and try again
 * before sending the guest to the error screen.
 */
async function captureWithRetry(camera: CameraSlot, attempts = 3): Promise<{ captureId: string } | null> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await agent.capture(camera);
    } catch {
      if (i < attempts - 1) await sleep(1000);
    }
  }
  return null;
}

/** How long before zero the camera is asked to focus. */
const PREFOCUS_LEAD_MS = 1_500;

/** Remounted per shot (via key) so each shot gets a fresh countdown and its own pre-focus. */
function Countdown({ seconds, onZero, onPrefocus }: { seconds: number; onZero: () => void; onPrefocus: () => void }) {
  const n = useCountdown(seconds, onZero);
  useEffect(() => {
    const t = setTimeout(onPrefocus, Math.max(0, seconds * 1000 - PREFOCUS_LEAD_MS));
    return () => clearTimeout(t);
    // Once per mount: `seconds` is fixed for this shot and the parent's callback identity doesn't matter.
  }, []);
  return <div className="count display">{Math.max(n, 1)}</div>;
}

export function GetReady({ session, onDone, onFail, onCancel }: {
  session: Session; onDone: (captureIds: string[]) => Promise<void>; onFail: () => void; onCancel: () => void;
}) {
  const total = shotCount(session.template);
  const [shots, setShots] = useState<string[]>([]);
  const [phase, setPhase] = useState<"count" | "flash" | "saving" | "composing">("count");
  // A capture still in flight when the guest taps ✕ must not drag the booth back into this session.
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  // Before the last shot is saved shots.length can't exceed total - 1; clamp for the brief moment after.
  const prompt = shotPrompt(session.template, Math.min(shots.length, total - 1));

  async function shoot() {
    setPhase("flash");
    // A Canon capture takes a second or two; keep the flash short and say what's happening after it.
    const shot = captureWithRetry(prompt.camera);
    await sleep(450);
    if (cancelled.current) return;
    setPhase("saving");
    const result = await shot;
    if (cancelled.current) return;
    if (!result) return onFail();
    const ids = [...shots, result.captureId];
    setShots(ids);
    if (ids.length < total) {
      setPhase("count");
    } else {
      setPhase("composing");
      await onDone(ids);
    }
  }

  return (
    <div className="stage getready">
      <img className="liveview" src={agentUrl(`/liveview?camera=${prompt.camera}`)} alt="" />
      <div className="tag live-tag">LIVE VIEW · MIRRORED</div>
      <div className="look-up">
        <div className="tag big">
          {prompt.text.includes("look down")
            ? <Icon size={40} d="M12 5v14"><path d="M19 12l-7 7-7-7" /></Icon>
            : <Icon size={40} d="M12 19V5"><path d="M5 12l7-7 7 7" /></Icon>}
          {prompt.text}
        </div>
      </div>
      <div className="corner tl" /><div className="corner tr" /><div className="corner bl" /><div className="corner br" />
      {phase === "count" && (
        <div className="overlay center col gap-40">
          <Countdown
            key={shots.length}
            seconds={shots.length === 0 ? session.firstCountdownSeconds : session.betweenShotsSeconds}
            onZero={shoot}
            onPrefocus={() => agent.prefocus(prompt.camera)}
          />
          <div className="tag big">{shots.length === 0 ? "Get ready…" : "Next pose!"}</div>
        </div>
      )}
      {phase === "saving" && (
        <div className="overlay center dim"><div className="tag big">Saving your photo…</div></div>
      )}
      {phase === "composing" && (
        <div className="overlay center dim"><div className="tag big">Putting your photos together…</div></div>
      )}
      {shots.length > 0 && (
        <div className="shot-strip">
          {shots.map((id) => <img key={id} src={agentUrl(`/captures/${id}/image`)} alt="" />)}
        </div>
      )}
      {phase === "flash" && <div className="overlay flash" />}
      <CloseButton onClick={onCancel} />
    </div>
  );
}

const compositeUrl = (captureId: string) => agentUrl(`/captures/${captureId}/image?variant=composite`);

/**
 * A print-ready sheet (a guest's composite, or a layout preview), shown the
 * way the guest will hold it. A landscape layout is stored turned onto the
 * portrait sheet, so it's turned back here.
 */
export function CompositePreview({ src, template, maxW, maxH }: {
  src: string; template: Template; maxW: number; maxH: number;
}) {
  const landscape = template.printSize === "4x6" && template.cellWidthPx > template.cellHeightPx;
  // Strips come out two-up on a portrait 4x6 sheet, so the file is always portrait unless turned.
  const [aw, ah] = landscape ? [3, 2] : [2, 3];
  const scale = Math.min(maxW / aw, maxH / ah);
  const [w, h] = [Math.round(aw * scale), Math.round(ah * scale)];
  return (
    <div className="composite" style={{ width: w, height: h }}>
      <img
        src={src}
        alt="Your print"
        style={landscape
          ? { width: h, height: w, left: (w - h) / 2, top: (h - w) / 2, transform: "rotate(-90deg)" }
          : { width: w, height: h, left: 0, top: 0 }}
      />
    </div>
  );
}

const RING = 326.73;

export function Review({ template, captureId, onApprove, onRetake, onCancel }: {
  template: Template; captureId: string; onApprove: () => void; onRetake: () => void; onCancel: () => void;
}) {
  const secs = useCountdown(10, onApprove);
  return (
    <div className="stage review">
      <CloseButton onClick={onCancel} />
      <div className="review-frame">
        <CompositePreview src={compositeUrl(captureId)} template={template} maxW={1140} maxH={900} />
      </div>
      <div className="col gap-40 grow">
        <h2 className="display fs-104">Looking<br />good?</h2>
        <p className="lede fs-32">We'll print it as soon as you say so.</p>
        <div className="row gap-20">
          <svg width="96" height="96" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#2B2533" strokeWidth="10" />
            <circle cx="60" cy="60" r="52" fill="none" stroke="#FF6A45" strokeWidth="10" strokeLinecap="round"
              strokeDasharray={RING} strokeDashoffset={RING * (1 - secs / 10)} transform="rotate(-90 60 60)" />
          </svg>
          <div className="muted fs-28">Printing automatically in <b className="hi">{secs}s</b></div>
        </div>
        <div className="col gap-24">
          <button type="button" className="btn primary block" onClick={onApprove}><CheckIcon size={48} />Looks good</button>
          <button type="button" className="btn outline block" onClick={onRetake}><RetakeIcon size={44} />Retake</button>
        </div>
      </div>
    </div>
  );
}

export function Printing({ template, captureId, waitMs, onContinue }: {
  template: Template; captureId: string; waitMs: number | null; onContinue: () => void;
}) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (waitMs === null) return;
    const end = Date.now() + waitMs;
    const tick = () => setLeft(Math.max(0, end - Date.now()));
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [waitMs]);
  // ponytail: progress is the agent's queue estimate (secondsPerPrint x position), not real printer
  // feedback - the agent has none. Switch to /print/history status if HFP ever reports completion.
  const pct = waitMs && left !== null ? 100 * (1 - left / waitMs) : 0;
  const what = template.printSize === "2x6-strip" ? "Two strips will drop" : "Your print will drop";

  return (
    <div className="stage printing">
      <CompositePreview src={compositeUrl(captureId)} template={template} maxW={620} maxH={900} />
      <div className="col gap-40 grow">
        <div className="pill row gap-14 fs-24 caps">
          <Icon size={28} d="M6 9V2h12v7">
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </Icon>
          PRINTING
        </div>
        <h2 className="display fs-112">Printing your<br />photos…</h2>
        <p className="lede fs-34">
          {left === null
            ? "Getting your print ready…"
            : <>{what} into the tray in about <b className="hi">{Math.ceil(left / 1000)} seconds</b>.</>}
        </p>
        <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
        {left === 0 && (
          <button type="button" className="btn primary md self-start" onClick={onContinue}>Continue</button>
        )}
      </div>
    </div>
  );
}

export function Done({ captureId, onFinish }: { captureId: string; onFinish: () => void }) {
  const secs = useCountdown(20, onFinish);
  const event = useEvent();
  const url = fillDownloadUrl(config.downloadUrlTemplate, captureId, event);
  const [qr, setQr] = useState("");
  useEffect(() => {
    if (url) QRCode.toDataURL(url, { margin: 0, width: 420, color: { dark: "#15121A", light: "#FBF8F3" } }).then(setQr);
  }, [url]);

  return (
    <div className="stage done">
      <div className="col gap-44 grow">
        <Logo />
        <h1 className="display fs-150">Your photo<br />is ready!</h1>
        <p className="lede">
          Grab your prints from the tray.{url && " Scan the code to save and share your photo."}
        </p>
        <div className="row gap-36">
          <button type="button" className="btn outline md" onClick={onFinish}>Finish</button>
          <div className="muted fs-28">Starting over in {secs}s</div>
        </div>
      </div>
      {url && (
        <div className="qr-card">
          {qr && <img src={qr} width={420} height={420} alt="QR code to download your photo" />}
          <div className="display fs-38">Scan to download</div>
          <div className="qr-url">{url.replace(/^https?:\/\//, "")}</div>
        </div>
      )}
    </div>
  );
}

export function Oops({ hint, onRetry, onCancel }: { hint?: string; onRetry: () => void; onCancel: () => void }) {
  return (
    <div className="stage oops">
      <CloseButton onClick={onCancel} />
      <div className="oops-icon"><RetakeIcon size={88} /></div>
      <h1 className="display fs-128 center-text">Let's try that again</h1>
      <p className="lede center-text wide">
        {hint ?? "Stand about 1.5 metres from the camera and hold still while it counts down."}
      </p>
      <button type="button" className="btn primary xl" onClick={onRetry}>Try again</button>
      <div className="muted fs-26">Nothing was printed.</div>
    </div>
  );
}
