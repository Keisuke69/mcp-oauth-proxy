import { describe, it, expect } from "vitest";
import { randomHex, sha256base64url, verifyPkce } from "../src/util";

describe("crypto", () => {
  it("sha256base64url matches RFC 7636 Appendix B", async () => {
    // verifier → challenge example from RFC 7636 Appendix B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await sha256base64url(verifier)).toBe(expected);
  });

  it("verifyPkce accepts matching verifier and rejects others", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce(verifier, challenge)).toBe(true);
    expect(await verifyPkce("not-the-verifier", challenge)).toBe(false);
  });

  it("randomHex produces the expected length and is not constant", () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
