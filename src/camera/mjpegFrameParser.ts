const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * ffmpeg's `-f mjpeg` pipe output has no framing beyond the JPEG images
 * themselves - each frame starts at its own SOI marker (0xFFD8) and ends at
 * its own EOI marker (0xFFD9), concatenated back-to-back with nothing in
 * between. Scanning for that marker pair is the standard way to split a raw
 * MJPEG byte stream back into individual frames.
 */
export class MjpegFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBufferBytes = 5 * 1024 * 1024) {}

  /** Feed newly-arrived bytes; returns any frames that completed as a result. */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start === -1) {
        // Keep a trailing lone 0xFF - it may be the first half of a marker
        // split across this chunk and the next one.
        this.buffer =
          this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === 0xff
            ? this.buffer.subarray(this.buffer.length - 1)
            : Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        // Bytes before the first SOI belong to no image - drop them.
        this.buffer = this.buffer.subarray(start);
      }
      const end = this.buffer.indexOf(EOI, SOI.length);
      if (end === -1) break; // frame hasn't fully arrived yet
      const frameEnd = end + EOI.length;
      frames.push(Buffer.from(this.buffer.subarray(0, frameEnd)));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    if (this.buffer.length > this.maxBufferBytes) {
      // A frame that never completes (corrupt stream, a dropped EOI) would
      // otherwise grow unbounded for the life of the process - a multi-hour
      // event is exactly where that would matter. Drop and resync on the
      // next SOI instead of leaking memory.
      this.buffer = Buffer.alloc(0);
    }

    return frames;
  }
}
