import { describe, it, expect } from "vitest";
import { MjpegFrameParser } from "../src/camera/mjpegFrameParser";

function jpeg(body: number[]): Buffer {
  return Buffer.from([0xff, 0xd8, ...body, 0xff, 0xd9]);
}

describe("MjpegFrameParser", () => {
  it("emits a single frame delivered in one push", () => {
    const parser = new MjpegFrameParser();
    const frame = jpeg([1, 2, 3]);

    expect(parser.push(frame)).toEqual([frame]);
  });

  it("waits for the EOI before emitting a frame split across pushes", () => {
    const parser = new MjpegFrameParser();
    const frame = jpeg([1, 2, 3, 4, 5]);
    const first = frame.subarray(0, 4);
    const second = frame.subarray(4);

    expect(parser.push(first)).toEqual([]);
    expect(parser.push(second)).toEqual([frame]);
  });

  it("emits every complete frame found in a single push", () => {
    const parser = new MjpegFrameParser();
    const a = jpeg([1]);
    const b = jpeg([2, 2]);
    const c = jpeg([3, 3, 3]);

    expect(parser.push(Buffer.concat([a, b, c]))).toEqual([a, b, c]);
  });

  it("drops leading bytes that arrive before the first SOI", () => {
    const parser = new MjpegFrameParser();
    const frame = jpeg([9, 9]);
    const withGarbage = Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), frame]);

    expect(parser.push(withGarbage)).toEqual([frame]);
  });

  it("reassembles an SOI marker split across a push boundary", () => {
    const parser = new MjpegFrameParser();
    const frame = jpeg([7, 7, 7]);
    // Split right after the leading 0xFF of the SOI marker.
    const first = frame.subarray(0, 1);
    const second = frame.subarray(1);

    expect(parser.push(first)).toEqual([]);
    expect(parser.push(second)).toEqual([frame]);
  });

  it("resyncs instead of growing unbounded when a frame never completes", () => {
    const parser = new MjpegFrameParser(16);
    const truncated = Buffer.from([0xff, 0xd8, ...Array(30).fill(0xaa)]);

    expect(parser.push(truncated)).toEqual([]);

    const nextFrame = jpeg([5]);
    expect(parser.push(nextFrame)).toEqual([nextFrame]);
  });
});
