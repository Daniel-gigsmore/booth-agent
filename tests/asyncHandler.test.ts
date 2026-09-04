import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../src/server/asyncHandler";

/**
 * Express 4 discards the promise an async handler returns. Unwrapped, a
 * rejection inside one is an unhandled rejection, which Node 22 terminates
 * the process over - so a single failing /health read could take the booth
 * offline mid-event while the camera and printer were both fine.
 */
describe("asyncHandler", () => {
  it("forwards a rejection to next() so Express's error handler sees it", async () => {
    const boom = new Error("statfs blew up");
    const next = vi.fn<NextFunction>();
    const handler = asyncHandler(async () => {
      throw boom;
    });

    handler({} as Request, {} as Response, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(boom));
  });

  it("leaves a successful handler alone", async () => {
    const next = vi.fn<NextFunction>();
    const json = vi.fn();
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });

    handler({} as Request, { json } as unknown as Response, next);
    await vi.waitFor(() => expect(json).toHaveBeenCalledWith({ ok: true }));
    expect(next).not.toHaveBeenCalled();
  });

  it("produces no unhandled rejection when the handler throws", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      asyncHandler(async () => {
        throw new Error("nope");
      })({} as Request, {} as Response, vi.fn<NextFunction>());
      // Two macrotask turns is well past when Node reports an unhandled
      // rejection for a promise nothing ever attached a catch to.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
