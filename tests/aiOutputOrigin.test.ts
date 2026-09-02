import { describe, expect, it } from "vitest";
import { assertAllowedAiOutputOrigin } from "../src/server/routes";

const SUPABASE_URL = "https://abcdefgh.supabase.co";

describe("assertAllowedAiOutputOrigin", () => {
  /**
   * aiOutputUrl is client-supplied on POST /composite and is only ever
   * supposed to be an already-generated image from this project's own
   * Supabase transform-image Edge Function. Without this check, downloadAiOutput's
   * fetch() would follow whatever URL a client with the shared secret handed
   * it - an SSRF primitive reaching internal/loopback addresses the agent has
   * no reason to touch.
   */
  it("allows a URL on the configured Supabase origin", () => {
    expect(() =>
      assertAllowedAiOutputOrigin(`${SUPABASE_URL}/storage/v1/object/public/ai-outputs/x.jpg`, SUPABASE_URL)
    ).not.toThrow();
  });

  it("rejects a different host entirely", () => {
    expect(() => assertAllowedAiOutputOrigin("https://evil.example.com/x.jpg", SUPABASE_URL)).toThrow(
      /aiOutputUrl must be hosted on/
    );
  });

  it("rejects an internal/loopback address - the actual SSRF target", () => {
    expect(() => assertAllowedAiOutputOrigin("http://127.0.0.1:8080/admin", SUPABASE_URL)).toThrow(
      /aiOutputUrl must be hosted on/
    );
    expect(() => assertAllowedAiOutputOrigin("http://169.254.169.254/latest/meta-data", SUPABASE_URL)).toThrow(
      /aiOutputUrl must be hosted on/
    );
  });

  it("rejects a lookalike host that merely contains the Supabase host as a substring", () => {
    expect(() =>
      assertAllowedAiOutputOrigin("https://abcdefgh.supabase.co.evil.com/x.jpg", SUPABASE_URL)
    ).toThrow(/aiOutputUrl must be hosted on/);
  });

  it("rejects a scheme downgrade even on the right host", () => {
    expect(() => assertAllowedAiOutputOrigin("http://abcdefgh.supabase.co/x.jpg", SUPABASE_URL)).toThrow(
      /aiOutputUrl must be hosted on/
    );
  });
});
