import { describe, it, expect } from "vitest";
import { LATER_AFTER_MS, imageUrl, parseLink, projectUrl, shareFileName, waitingState } from "../download/photo.js";

const ID = "080984fe-674a-469b-83c6-493f9bf2d3d5";

describe("parseLink", () => {
  it("reads event, id and name", () => {
    expect(parseLink(`?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id=${ID}`))
      .toEqual({ event: "gigsmore-launch-2026", id: ID, name: "Gigsmore Launch", project: null });
  });

  it("treats a missing or blank name as null", () => {
    expect(parseLink(`?event=evt&id=${ID}`)?.name).toBeNull();
    expect(parseLink(`?event=evt&name=%20&id=${ID}`)?.name).toBeNull();
  });

  it("accepts an upper-case UUID", () => {
    expect(parseLink(`?event=evt&id=${ID.toUpperCase()}`)?.id).toBe(ID.toUpperCase());
  });

  it("rejects a missing or malformed event or id", () => {
    for (const search of [
      `?id=${ID}`,
      "?event=evt",
      "?event=evt&id=not-a-uuid",
      `?event=evt&id=${ID}x`,
      `?event=../other&id=${ID}`,
      `?event=a%2Fb&id=${ID}`,
      `?event=evt&id=${ID}&p=NOT-A-REF`,
      `?event=evt&id=${ID}&p=abc`,
      "",
    ]) {
      expect(parseLink(search), search).toBeNull();
    }
  });
});

describe("imageUrl", () => {
  it("is the public object URL with a cache-buster", () => {
    expect(imageUrl({ event: "gigsmore-launch-2026", id: ID, name: null, project: null }, 1234)).toBe(
      `https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures/gigsmore-launch-2026/${ID}.jpg?t=1234`
    );
  });
});

describe("waitingState", () => {
  it("is uploading for the first two minutes, then later", () => {
    expect(waitingState(0)).toBe("uploading");
    expect(waitingState(LATER_AFTER_MS - 1)).toBe("uploading");
    expect(waitingState(LATER_AFTER_MS)).toBe("later");
    expect(waitingState(10 * 60_000)).toBe("later");
  });
});

describe("shareFileName", () => {
  it("names the file after the event and the id's first 8 characters", () => {
    expect(shareFileName({ event: "gigsmore-launch-2026", id: ID, name: null, project: null })).toBe("kachak-gigsmore-launch-2026-080984fe.jpg");
  });
});

describe("project", () => {
  it("reads p as the Supabase project ref", () => {
    expect(parseLink(`?event=evt&id=${ID}&p=abcdefghijklmnopqrst`)?.project).toBe("abcdefghijklmnopqrst");
  });

  it("points at p's project, or the default without it", () => {
    expect(projectUrl({ project: "abcdefghijklmnopqrst" })).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(projectUrl({ project: null })).toBe("https://pbtnvpykoueiizsvjwlo.supabase.co");
    expect(imageUrl({ event: "evt", id: ID, name: null, project: "abcdefghijklmnopqrst" }, 7)).toBe(
      `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/captures/evt/${ID}.jpg?t=7`
    );
  });
});
