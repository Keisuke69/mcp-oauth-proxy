import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredCode, Association } from "../src/oauth";

async function clearKV(): Promise<void> {
  const list = await env.KV.list();
  for (const key of list.keys) await env.KV.delete(key.name);
}

describe("OAuth discovery", () => {
  it("returns protected resource metadata", async () => {
    const r = await SELF.fetch("http://proxy.example/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    const data = (await r.json()) as { resource: string; authorization_servers: string[] };
    expect(data.resource).toBe("http://proxy.example/mcp");
    expect(data.authorization_servers).toEqual(["http://proxy.example"]);
  });

  it("returns protected resource metadata for sub-paths", async () => {
    const r = await SELF.fetch("http://proxy.example/.well-known/oauth-protected-resource/mcp");
    expect(r.status).toBe(200);
  });

  it("returns authorization server metadata", async () => {
    const r = await SELF.fetch("http://proxy.example/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    const data = (await r.json()) as Record<string, unknown>;
    expect(data.issuer).toBe("http://proxy.example");
    expect(data.authorization_endpoint).toBe("http://proxy.example/authorize");
    expect(data.token_endpoint).toBe("http://proxy.example/token");
    expect(data.registration_endpoint).toBe("http://proxy.example/register");
    expect(data.code_challenge_methods_supported).toEqual(["S256"]);
    expect(data.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("/register", () => {
  it("returns a UUID client_id and echoes redirect_uris", async () => {
    const r = await SELF.fetch("http://proxy.example/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/cb"] }),
    });
    expect(r.status).toBe(200);
    const data = (await r.json()) as Record<string, unknown>;
    expect(data.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.redirect_uris).toEqual(["https://client.example/cb"]);
    expect(data.token_endpoint_auth_method).toBe("none");
  });

  it("tolerates empty body", async () => {
    const r = await SELF.fetch("http://proxy.example/register", { method: "POST" });
    expect(r.status).toBe(200);
    const data = (await r.json()) as Record<string, unknown>;
    expect(data.redirect_uris).toEqual([]);
  });
});

describe("/authorize (GET)", () => {
  it("renders the consent form", async () => {
    const q = new URLSearchParams({
      client_id: "c1",
      redirect_uri: "https://client.example/cb",
      response_type: "code",
      code_challenge: "abc",
      code_challenge_method: "S256",
      state: "xyz",
    });
    const r = await SELF.fetch(`http://proxy.example/authorize?${q.toString()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type") ?? "").toContain("text/html");
    const body = await r.text();
    expect(body).toContain("Authorize MCP Proxy");
    expect(body).toContain('name="admin_secret"');
    expect(body).toContain('value="c1"');
    expect(body).toContain('value="xyz"');
  });

  it("rejects non-S256 challenge methods", async () => {
    const r = await SELF.fetch(
      "http://proxy.example/authorize?redirect_uri=x&code_challenge=y&code_challenge_method=plain",
    );
    expect(r.status).toBe(400);
  });

  it("rejects missing required params", async () => {
    const r = await SELF.fetch("http://proxy.example/authorize");
    expect(r.status).toBe(400);
  });
});

describe("/authorize (POST)", () => {
  beforeEach(clearKV);

  it("returns 401 when admin password is wrong", async () => {
    const form = new URLSearchParams({
      redirect_uri: "https://client.example/cb",
      code_challenge: "ch",
      client_id: "c",
      upstream_url: "https://upstream.example/mcp",
      header_value: "Bearer x",
      admin_secret: "wrong",
    });
    const r = await SELF.fetch("http://proxy.example/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("Admin password is incorrect");
  });

  it("issues a code, stores it in KV, and redirects", async () => {
    const form = new URLSearchParams({
      redirect_uri: "https://client.example/cb",
      state: "s123",
      code_challenge: "ch",
      client_id: "the-client",
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer upstream-token",
      admin_secret: "test-admin-secret",
    });
    const r = await SELF.fetch("http://proxy.example/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    const location = r.headers.get("Location");
    expect(location).toBeTruthy();
    const loc = new URL(location ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe("https://client.example/cb");
    expect(loc.searchParams.get("state")).toBe("s123");

    const code = loc.searchParams.get("code");
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const stored = await env.KV.get<StoredCode>(`code:${code}`, "json");
    expect(stored).toMatchObject({
      code_challenge: "ch",
      client_id: "the-client",
      redirect_uri: "https://client.example/cb",
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer upstream-token",
    });
  });

  it("rejects an invalid upstream_url", async () => {
    const form = new URLSearchParams({
      redirect_uri: "https://client.example/cb",
      code_challenge: "ch",
      client_id: "c",
      upstream_url: "not a url",
      header_value: "Bearer x",
      admin_secret: "test-admin-secret",
    });
    const r = await SELF.fetch("http://proxy.example/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Upstream URL is invalid");
  });
});

describe("/token", () => {
  beforeEach(clearKV);

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  async function seedCode(code: string, challengeOverride = challenge): Promise<void> {
    const stored: StoredCode = {
      code_challenge: challengeOverride,
      client_id: "c",
      redirect_uri: "https://client.example/cb",
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer upstream-token",
    };
    await env.KV.put(`code:${code}`, JSON.stringify(stored));
  }

  it("returns tokens when PKCE matches and consumes the code", async () => {
    await seedCode("abc123");

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "abc123",
      code_verifier: verifier,
    });
    const r = await SELF.fetch("http://proxy.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(200);
    const data = (await r.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBe(3600);
    expect(data.access_token).toMatch(/^[0-9a-f]{80}$/);
    expect(data.refresh_token).toMatch(/^[0-9a-f]{80}$/);

    expect(await env.KV.get("code:abc123")).toBeNull();
    const assoc = await env.KV.get<Association>(`token:${data.access_token}`, "json");
    expect(assoc).toEqual({
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer upstream-token",
    });
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    await seedCode("codebad");

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "codebad",
      code_verifier: "not-the-verifier",
    });
    const r = await SELF.fetch("http://proxy.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects an unknown code with invalid_grant", async () => {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "missing",
      code_verifier: verifier,
    });
    const r = await SELF.fetch("http://proxy.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_grant" });
  });

  it("exchanges a refresh_token for a fresh access_token", async () => {
    await env.KV.put(
      "refresh:rt1",
      JSON.stringify({
        upstream_url: "https://upstream.example/mcp",
        header_name: "Authorization",
        header_value: "Bearer upstream-token",
      } satisfies Association),
    );
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "rt1",
    });
    const r = await SELF.fetch("http://proxy.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(200);
    const data = (await r.json()) as Record<string, unknown>;
    expect(data.access_token).toMatch(/^[0-9a-f]{80}$/);
    expect(data.refresh_token).toBeUndefined();
  });

  it("rejects unsupported grant types", async () => {
    const form = new URLSearchParams({ grant_type: "password" });
    const r = await SELF.fetch("http://proxy.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "unsupported_grant_type" });
  });
});
