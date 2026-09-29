import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { agent, config, printUrl } from "./agent";
import { mergeAlbum, nextSlide, type SlideState } from "./album";

const POLL_MS = 15_000;
const SLIDE_MS = 6_000;

/** One print's download QR (the same page as the Done screen's), or nothing when that page isn't set up. */
function PhotoQr({ id }: { id: string }) {
  const url = config.downloadUrl(id);
  const [qr, setQr] = useState("");
  useEffect(() => {
    setQr("");
    if (url) QRCode.toDataURL(url, { margin: 0, width: 300, color: { dark: "#15121A", light: "#FBF8F3" } }).then(setQr);
  }, [url]);
  if (!url) return null;
  return (
    <div className="qr-card album-photo-qr">
      {qr && <img src={qr} width={300} height={300} alt="QR code to download this photo" />}
      <div className="display fs-32">Scan to download</div>
    </div>
  );
}

/**
 * The event album inside the kiosk: every print so far as a grid (newest first, so a guest finds
 * theirs), one print large with its download QR, and a slideshow. Read from the agent, so it works
 * offline. Guests reach it from Attract, the operator from the Album tab.
 */
export default function AlbumScreen({ onClose }: { onClose: () => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [slide, setSlide] = useState<string | null>(null);
  // Bumped when a slide's file won't load, which moves the slideshow straight on.
  const [skips, setSkips] = useState(0);
  // The slideshow's place and its queue of prints that arrive while it plays.
  const [show] = useState<SlideState>(() => ({ order: [], queue: [], current: null, loaded: false }));

  useEffect(() => {
    let alive = true;
    const load = () =>
      agent.albumPhotos().then(
        (list) => {
          if (!alive) return;
          mergeAlbum(show, list);
          setIds(list);
          setLoaded(true);
        },
        () => alive && setLoaded(true),
      );
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [show]);

  useEffect(() => {
    if (!playing) return;
    const step = () => {
      ({ current: show.current, queue: show.queue } = nextSlide(show.order, show.queue, show.current));
      setSlide(show.current);
    };
    step();
    const t = setInterval(step, SLIDE_MS);
    return () => clearInterval(t);
  }, [playing, show, skips]);

  const newest = [...ids].reverse();
  const current = viewing === null ? null : newest[viewing] ?? null;
  const step = (d: number) => setViewing((v) => (v === null ? v : (v + d + newest.length) % newest.length));

  return (
    <div className="stage album-screen">
      <button type="button" className="close-x" aria-label="Close the album" onClick={onClose}>
        <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <div className="row gap-36 album-head">
        <div className="logo"><span className="logo-dot" />KACHAK</div>
        {config.eventName && <div className="pill">{config.eventName}</div>}
        {ids.length > 0 && (
          <button type="button" className="btn primary md" onClick={() => setPlaying(true)}>▶ Play</button>
        )}
      </div>

      {loaded && ids.length === 0 ? (
        <div className="album-empty display fs-64">No photos yet - be the first!</div>
      ) : (
        <div className="album-grid">
          {newest.map((id, i) => (
            <button key={id} type="button" className="album-thumb" onClick={() => setViewing(i)}>
              {/* A print whose file is gone (e.g. deleted by hand) is left out rather than shown blank. */}
              <img src={printUrl(id)} alt="" loading="lazy" onError={(e) => { e.currentTarget.parentElement!.hidden = true; }} />
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="album-viewer">
          <img className="album-big" src={printUrl(current)} alt="" />
          <div className="col gap-36 center">
            <PhotoQr id={current} />
            <div className="row gap-20">
              <button type="button" className="btn outline md album-nav" aria-label="Previous photo" onClick={() => step(-1)}>‹</button>
              <button type="button" className="btn outline md album-nav" aria-label="Next photo" onClick={() => step(1)}>›</button>
            </div>
            <button type="button" className="btn outline md" onClick={() => setViewing(null)}>Back to album</button>
          </div>
        </div>
      )}

      {playing && (
        <div className="album-show" onClick={() => setPlaying(false)}>
          {slide && <img key={slide} src={printUrl(slide)} alt="" onError={() => setSkips((n) => n + 1)} />}
          <div className="album-show-hint muted fs-26">Tap to stop</div>
        </div>
      )}
    </div>
  );
}
