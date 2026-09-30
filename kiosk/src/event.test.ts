import { describe, expect, it } from "vitest";
import { fillDownloadUrl } from "./event";

const EVENT = { id: "tumi-2026-10-05", name: "TUMI & Co", date: "2026-10-05" };

describe("fillDownloadUrl", () => {
  it("fills the capture id and the event from the agent, URL-encoded", () => {
    expect(fillDownloadUrl("https://x.app/?event={eventId}&name={eventName}&id={captureId}", "c1", EVENT)).toBe(
      "https://x.app/?event=tumi-2026-10-05&name=TUMI%20%26%20Co&id=c1",
    );
  });

  it("still works with an old URL that names a fixed event", () => {
    expect(fillDownloadUrl("https://x.app/?event=gigsmore&id={captureId}", "c1", EVENT)).toBe("https://x.app/?event=gigsmore&id=c1");
  });

  it("is empty when the download page isn't set up", () => {
    expect(fillDownloadUrl("", "c1", EVENT)).toBe("");
  });

  it("is empty until the agent has said which event is on, when the URL needs it", () => {
    expect(fillDownloadUrl("https://x.app/?event={eventId}&id={captureId}", "c1", null)).toBe("");
  });
});
