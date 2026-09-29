import { describe, it, expect } from "vitest";
import { albumFileName, manifestIds, manifestUrl, newIds, nextSlide, parseAlbumLink, photoUrl } from "../download/album-logic.js";

const ID1 = "080984fe-674a-469b-83c6-493f9bf2d3d5";
const ID2 = "1b2c3d4e-0000-4000-8000-000000000002";
const ID3 = "1b2c3d4e-0000-4000-8000-000000000003";
const TOKEN = "Abc123_-Abc123_-xyz";
const DEFAULT = "https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures";

describe("parseAlbumLink", () => {
  it("reads an online link", () => {
    expect(parseAlbumLink(`?event=gigsmore-launch-2026&name=Gigsmore%20Launch&album=${TOKEN}`)).toEqual({
      source: "online", event: "gigsmore-launch-2026", album: TOKEN, name: "Gigsmore Launch", project: null, play: false,
    });
  });

  it("reads p and play", () => {
    expect(parseAlbumLink(`?event=evt&album=${TOKEN}&p=abcdefghijklmnopqrst&play=1`)).toMatchObject({
      project: "abcdefghijklmnopqrst", play: true,
    });
  });

  it("reads a local link", () => {
    expect(parseAlbumLink("?local=1&token=s3cret&name=Gigsmore&play=1")).toEqual({
      source: "local", token: "s3cret", name: "Gigsmore", play: true,
    });
  });

  it("rejects missing or malformed values", () => {
    for (const search of [
      `?album=${TOKEN}`,
      "?event=evt",
      "?event=evt&album=tooshort",
      `?event=../x&album=${TOKEN}`,
      `?event=evt&album=${TOKEN}&p=NOT-A-REF`,
      `?event=evt&album=${TOKEN}&p=abc`,
      "?local=1",
      "",
    ]) {
      expect(parseAlbumLink(search), search).toBeNull();
    }
  });
});

describe("URLs", () => {
  it("builds online manifest and photo URLs on the default project", () => {
    const link = parseAlbumLink(`?event=evt&album=${TOKEN}`);
    expect(manifestUrl(link, 42)).toBe(`${DEFAULT}/evt/albums/${TOKEN}.json?t=42`);
    expect(photoUrl(link, ID1)).toBe(`${DEFAULT}/evt/${ID1}.jpg`);
  });

  it("uses p as the project", () => {
    const link = parseAlbumLink(`?event=evt&album=${TOKEN}&p=abcdefghijklmnopqrst`);
    expect(photoUrl(link, ID1)).toBe(`https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/captures/evt/${ID1}.jpg`);
  });

  it("builds local URLs against the agent, carrying the token", () => {
    const link = parseAlbumLink("?local=1&token=a%26b");
    expect(manifestUrl(link, 42)).toBe("/album.json?token=a%26b&t=42");
    expect(photoUrl(link, ID1)).toBe(`/captures/${ID1}/image?variant=composite&token=a%26b`);
  });

  it("names saved files after the event, or 'album' locally", () => {
    expect(albumFileName(parseAlbumLink(`?event=evt&album=${TOKEN}`), ID1)).toBe("kachak-evt-080984fe.jpg");
    expect(albumFileName(parseAlbumLink("?local=1&token=x"), ID1)).toBe("kachak-album-080984fe.jpg");
  });
});

describe("manifestIds", () => {
  it("returns the ids in order and drops anything malformed", () => {
    expect(manifestIds({ updatedAt: "x", photos: [{ id: ID1 }, { id: "../evil" }, null, { id: ID2 }, { nope: 1 }] })).toEqual([ID1, ID2]);
  });

  it("is empty for a manifest that isn't one", () => {
    expect(manifestIds(null)).toEqual([]);
    expect(manifestIds({ photos: "no" })).toEqual([]);
  });
});

describe("newIds", () => {
  it("returns the ids not seen before, in manifest order", () => {
    expect(newIds([ID1], [ID1, ID2, ID3])).toEqual([ID2, ID3]);
    expect(newIds([ID1, ID2], [ID1, ID2])).toEqual([]);
  });
});

describe("nextSlide", () => {
  it("plays new arrivals first", () => {
    expect(nextSlide([ID1, ID2, ID3], [ID3], ID1)).toEqual({ current: ID3, queue: [] });
  });

  it("otherwise moves on through the album and loops", () => {
    expect(nextSlide([ID1, ID2], [], ID1)).toEqual({ current: ID2, queue: [] });
    expect(nextSlide([ID1, ID2], [], ID2)).toEqual({ current: ID1, queue: [] });
  });

  it("starts at the top when nothing is showing yet", () => {
    expect(nextSlide([ID1, ID2], [], null)).toEqual({ current: ID1, queue: [] });
  });

  it("has nothing to show for an empty album", () => {
    expect(nextSlide([], [], null)).toEqual({ current: null, queue: [] });
  });
});
