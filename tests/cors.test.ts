import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { corsMiddleware } from "../src/server/cors";

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    sendStatus: vi.fn(),
  };
  return { res: res as unknown as Response, headers };
}

describe("corsMiddleware", () => {
  it("always sets Vary: Origin, even when the origin is rejected", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res, headers } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware(
      { method: "GET", headers: { origin: "https://evil.example" } } as unknown as Request,
      res,
      next
    );

    expect(headers["Vary"]).toBe("Origin");
  });

  it("echoes the exact origin (not *) for an allowed cross-origin GET, and calls next", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res, headers } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware(
      { method: "GET", headers: { origin: "https://kiosk.example" } } as unknown as Request,
      res,
      next
    );

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://kiosk.example");
    expect(next).toHaveBeenCalledOnce();
    expect((res.sendStatus as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("does not set Access-Control-Allow-Origin for a disallowed origin, but still calls next for non-OPTIONS", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res, headers } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware(
      { method: "GET", headers: { origin: "https://evil.example" } } as unknown as Request,
      res,
      next
    );

    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // The browser blocks the real request client-side either way once the
    // approval header is missing - the middleware isn't the enforcement
    // point for a plain GET/POST, only for the preflight OPTIONS itself.
    expect(next).toHaveBeenCalledOnce();
  });

  it("treats an OPTIONS request with no Origin header as a normal request, not a preflight", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware({ method: "OPTIONS", headers: {} } as unknown as Request, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res.sendStatus as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("responds 403 to a real preflight from a disallowed origin, without calling next", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware(
      { method: "OPTIONS", headers: { origin: "https://evil.example" } } as unknown as Request,
      res,
      next
    );

    expect(res.sendStatus).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers a real preflight from an allowed origin with 204 and the CORS headers, without calling next", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res, headers } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware(
      { method: "OPTIONS", headers: { origin: "https://kiosk.example" } } as unknown as Request,
      res,
      next
    );

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://kiosk.example");
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    expect(headers["Access-Control-Allow-Headers"]).toBe("Authorization, Content-Type");
    expect(headers["Access-Control-Max-Age"]).toBe("600");
    expect(res.sendStatus).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });

  it("falls through untouched for a non-browser request with no Origin header at all", () => {
    const middleware = corsMiddleware(() => ["https://kiosk.example"]);
    const { res, headers } = makeRes();
    const next = vi.fn<NextFunction>();

    middleware({ method: "GET", headers: {} } as unknown as Request, res, next);

    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("re-reads the allowlist on every call, picking up a config reload with no restart", () => {
    let origins: string[] = [];
    const middleware = corsMiddleware(() => origins);
    const next = vi.fn<NextFunction>();

    const { res: res1, headers: headers1 } = makeRes();
    middleware(
      { method: "GET", headers: { origin: "https://kiosk.example" } } as unknown as Request,
      res1,
      next
    );
    expect(headers1["Access-Control-Allow-Origin"]).toBeUndefined();

    origins = ["https://kiosk.example"];
    const { res: res2, headers: headers2 } = makeRes();
    middleware(
      { method: "GET", headers: { origin: "https://kiosk.example" } } as unknown as Request,
      res2,
      next
    );
    expect(headers2["Access-Control-Allow-Origin"]).toBe("https://kiosk.example");
  });
});
