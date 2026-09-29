import { describe, it, expect } from "vitest";
import { LATER_AFTER_MS, imageUrl, parseLink, shareFileName, waitingState } from "../download/photo.js";

const ID = "080984fe-674a-469b-83c6-493f9bf2d3d5";

describe("parseLink", () => {
  it("reads event, id and name", () => {
    expect(parseLink(`?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id=${ID}`))
      .toEqual({ event: "gigsmore-launch-2026", id: ID, name: "Gigsmore Launch" });
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
      "",
    ]) {
      expect(parseLink(search), search).toBeNull();
    }
  });
});

describe("imageUrl", () => {
  it("is the public object URL with a cache-buster", () => {
    expect(imageUrl({ event: "gigsmore-launch-2026", id: ID, name: null }, 1234)).toBe(
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
    expect(shareFileName({ event: "gigsmore-launch-2026", id: ID, name: null })).toBe("kachak-gigsmore-launch-2026-080984fe.jpg");
  });
});
