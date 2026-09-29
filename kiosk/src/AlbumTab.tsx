import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { agent, config, localSlideshowUrl } from "./agent";
import { AlbumInfo, albumLink } from "./album";
import { useHealth } from "./hooks";

// Window Management API (Chrome): lists the screens so the slideshow can open on the second one.
interface ScreenDetailed { availLeft: number; availTop: number; availWidth: number; availHeight: number; isPrimary: boolean }
type ScreenWindow = Window & { getScreenDetails?: () => Promise<{ screens: ScreenDetailed[] }> };

/** Opens the booth's own album, playing, on a screen other than the primary one. Throws a message for the operator. */
async function openOnSecondScreen(url: string): Promise<void> {
  const w = window as ScreenWindow;
  if (!w.getScreenDetails) throw new Error("This browser can't place windows on other screens - run start-slideshow.ps1 instead.");
  const { screens } = await w.getScreenDetails().catch(() => {
    // Denied, or the prompt never showed: Chrome in kiosk mode may not ask at all.
    throw new Error("Chrome didn't allow using the other screen. Run kiosk\\start-slideshow.ps1 on the booth PC instead.");
  });
  const other = screens.find((s) => !s.isPrimary);
  if (!other) throw new Error("Only one screen is connected. Plug in the TV or projector first.");
  const features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
  // The first time, Chrome's permission prompt can use up the click, so the window is blocked; a second press works.
  if (!window.open(url, "kachak-slideshow", features)) {
    throw new Error("Chrome blocked the window. Press the button again; if it still doesn't open, run kiosk\\start-slideshow.ps1.");
  }
}

export default function AlbumTab() {
  const health = useHealth(5_000);
  const [info, setInfo] = useState<AlbumInfo | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    agent.albumInfo().then(setInfo, (e: Error) => setError(e.message));
  }, []);

  const link = info ? albumLink(config.downloadUrlTemplate, info) : null;
  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 0, width: 360, color: { dark: "#15121A", light: "#FBF8F3" } }).then(setQr);
  }, [link]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNote("Link copied.");
    } catch {
      setNote("Couldn't copy - select the link and copy it by hand.");
    }
  }

  async function toggleAttract() {
    if (!info) return;
    const next = !info.attractSlideshow;
    try {
      await agent.setAttractSlideshow(next);
      setInfo({ ...info, attractSlideshow: next });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function secondScreen() {
    if (!info) return;
    try {
      await openOnSecondScreen(localSlideshowUrl(info.eventName));
      setNote("Slideshow opened on the second screen. Click it once to go full screen.");
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  const status = health?.album;
  return (
    <div className="row gap-40 album-tab">
      <div className="col gap-24 grow">
        {error && <div className="banner warn">{error}</div>}
        {info && !info.token && (
          <div className="banner warn">
            The online album is off. Add "album": {"{"} "token": "…" {"}"} to booth.config.json (see download/README.md).
          </div>
        )}
        {info?.token && !link && (
          <div className="banner warn">The guest download page isn't set up (VITE_DOWNLOAD_URL), so there's no album link.</div>
        )}
        {link && (
          <div className="col gap-20">
            <div className="op-label">ONLINE ALBUM - SEND THIS TO THE CLIENT</div>
            <div className="album-link">{link}</div>
            <div className="row gap-20">
              <button type="button" className="btn primary sm" onClick={() => void copy()}>Copy link</button>
            </div>
          </div>
        )}
        {status?.enabled && (
          <div className="muted fs-24">
            {status.photoCount ?? 0} prints in the album
            {status.lastWrittenAt && `, updated ${new Date(status.lastWrittenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            {status.lastError && ` - not updating: ${status.lastError}`}
          </div>
        )}

        <div className="col gap-20">
          <div className="op-label">BOOTH SCREENS</div>
          <div className="row gap-20">
            <button type="button" className="btn outline sm" disabled={!info} onClick={() => void secondScreen()}>
              Slideshow on second screen
            </button>
            <button type="button" className="btn outline sm" disabled={!info} onClick={() => void toggleAttract()}>
              {info?.attractSlideshow ? "Hide prints on start screen" : "Show prints on start screen"}
            </button>
          </div>
          <div className="muted fs-24">
            Start screen: {info ? (info.attractSlideshow ? "shows this event's prints" : "shows the sample strips") : "…"}.
            Second screen not opening? Run kiosk\start-slideshow.ps1 on the booth PC.
          </div>
        </div>
        {note && <div className="muted fs-24">{note}</div>}
      </div>

      {link && qr && (
        <div className="qr-card album-qr">
          <img src={qr} width={360} height={360} alt="QR code for the event album" />
          <div className="display fs-38">Scan for the album</div>
        </div>
      )}
    </div>
  );
}
