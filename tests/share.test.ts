import { afterEach, describe, expect, it, vi } from "vitest";
import { sharePhoto } from "../download/share.js";

const file = new File([new Uint8Array([1, 2, 3])], "kachak-evt-12345678.jpg", { type: "image/jpeg" });

/** Stands in for document.createElement("a") and records each download click. */
function stubDownload() {
  const clicks: Array<{ href: string; download: string }> = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const a = { href: "", download: "", click: () => clicks.push({ href: a.href, download: a.download }) };
      return a;
    },
  });
  return clicks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sharePhoto", () => {
  it("uses the share sheet when it takes files", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { canShare: () => true, share });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(clicks).toEqual([]);
  });

  it("does nothing more when the guest cancels", async () => {
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => { throw new DOMException("cancelled", "AbortError"); } });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toEqual([]);
  });

  it("downloads when sharing fails for another reason", async () => {
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => { throw new DOMException("busy", "InvalidStateError"); } });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe("kachak-evt-12345678.jpg");
  });

  it("downloads when the browser can't share files", async () => {
    vi.stubGlobal("navigator", {});
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toHaveLength(1);
  });
});
