import { describe, expect, it } from "vitest";
import { albumLink, newIds, nextSlide } from "./album";

const INFO = { token: "tok-0123456789abcdef", eventId: "gigsmore-launch-2026", eventName: "Gigsmore Launch", attractSlideshow: true };
const DOWNLOAD = "https://booth-agent-daniel-team22.vercel.app/?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id={captureId}";

describe("albumLink", () => {
  it("builds the online album link on the download page's site", () => {
    expect(albumLink(DOWNLOAD, INFO)).toBe(
      "https://booth-agent-daniel-team22.vercel.app/album.html?event=gigsmore-launch-2026&name=Gigsmore+Launch&album=tok-0123456789abcdef",
    );
  });

  it("carries the download link's project ref over", () => {
    expect(albumLink(`${DOWNLOAD}&p=abcdefghijklmnopqrst`, INFO)).toMatch(/&p=abcdefghijklmnopqrst$/);
  });

  it("is null without a token or a download site", () => {
    expect(albumLink(DOWNLOAD, { ...INFO, token: null })).toBeNull();
    expect(albumLink("", INFO)).toBeNull();
    expect(albumLink("not a url", INFO)).toBeNull();
  });
});

describe("newIds", () => {
  it("returns the ids not seen before, in order", () => {
    expect(newIds(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});

describe("nextSlide", () => {
  it("plays new arrivals first, then loops through the album", () => {
    expect(nextSlide(["a", "b", "c"], ["c"], "a")).toEqual({ current: "c", queue: [] });
    expect(nextSlide(["a", "b"], [], "b")).toEqual({ current: "a", queue: [] });
    expect(nextSlide(["a", "b"], [], null)).toEqual({ current: "a", queue: [] });
    expect(nextSlide([], [], null)).toEqual({ current: null, queue: [] });
  });
});
