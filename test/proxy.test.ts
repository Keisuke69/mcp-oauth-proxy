import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Association } from "../src/oauth";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function clearKV(): Promise<void> {
  const list = await env.KV.list();
  for (const key of list.keys) await env.KV.delete(key.name);
}

async function seedToken(token: string, assoc: Association): Promise<void> {
  await env.KV.put(`token:${token}`, JSON.stringify(assoc));
}

describe("/mcp proxy", () => {
  beforeEach(clearKV);

  it("returns 401 + WWW-Authenticate when no bearer is sent", async () => {
    const r = await SELF.fetch("http://proxy.example/mcp");
    expect(r.status).toBe(401);
    const www = r.headers.get("WWW-Authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain(
      'resource_metadata="http://proxy.example/.well-known/oauth-protected-resource"',
    );
  });

  it("returns 401 when bearer is unknown", async () => {
    const r = await SELF.fetch("http://proxy.example/mcp", {
      headers: { Authorization: "Bearer nonexistent" },
    });
    expect(r.status).toBe(401);
  });

  it("forwards to upstream with the configured Authorization header", async () => {
    await seedToken("goodtoken", {
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer UPSTREAM-SECRET",
    });

    fetchMock
      .get("https://upstream.example")
      .intercept({
        path: "/mcp",
        method: "POST",
        headers: { Authorization: "Bearer UPSTREAM-SECRET" },
      })
      .reply(200, "upstream-ok", {
        headers: { "Content-Type": "text/plain" },
      });

    const r = await SELF.fetch("http://proxy.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer goodtoken",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("upstream-ok");
  });

  it("forwards to upstream with a custom header name", async () => {
    await seedToken("apikeyuser", {
      upstream_url: "https://upstream.example/mcp",
      header_name: "X-API-Key",
      header_value: "API-SECRET",
    });

    fetchMock
      .get("https://upstream.example")
      .intercept({
        path: "/mcp",
        method: "POST",
        headers: { "X-API-Key": "API-SECRET" },
      })
      .reply(200, "upstream-ok");

    const r = await SELF.fetch("http://proxy.example/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer apikeyuser" },
      body: "{}",
    });
    expect(r.status).toBe(200);
  });

  it("also matches /mcp sub-paths", async () => {
    await seedToken("goodtoken2", {
      upstream_url: "https://upstream.example/mcp",
      header_name: "Authorization",
      header_value: "Bearer UPSTREAM-SECRET",
    });

    fetchMock
      .get("https://upstream.example")
      .intercept({ path: "/mcp", method: "GET" })
      .reply(200, "ok");

    const r = await SELF.fetch("http://proxy.example/mcp/sse", {
      headers: { Authorization: "Bearer goodtoken2" },
    });
    expect(r.status).toBe(200);
  });
});
