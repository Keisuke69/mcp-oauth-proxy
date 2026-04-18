import type { Env } from "./index";
import { consentPage } from "./consent";
import { html, json, randomHex, verifyPkce } from "./util";

export interface Association {
  upstream_url: string;
  header_name: string;
  header_value: string;
}

export interface StoredCode extends Association {
  code_challenge: string;
  client_id: string;
  redirect_uri: string;
}

const TTL_CODE = 600;
const TTL_ACCESS = 3600;
const TTL_REFRESH = 30 * 86400;

export function discoveryProtectedResource(origin: string): Response {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
  });
}

export function discoveryAuthorizationServer(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export async function handleRegister(request: Request): Promise<Response> {
  const body = await request.json().catch((): unknown => ({}));
  const uris =
    typeof body === "object" && body !== null
      ? (body as { redirect_uris?: unknown }).redirect_uris
      : undefined;
  const redirectUris = Array.isArray(uris)
    ? uris.filter((u): u is string => typeof u === "string")
    : [];
  return json({
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

export function handleAuthorizeGet(url: URL): Response {
  const p = url.searchParams;
  if (
    !p.get("redirect_uri") ||
    !p.get("code_challenge") ||
    p.get("code_challenge_method") !== "S256"
  ) {
    return new Response("invalid_request", { status: 400 });
  }
  return html(consentPage(p));
}

export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();

  if (!env.ADMIN_SECRET || form.get("admin_secret") !== env.ADMIN_SECRET) {
    return html(consentPage(paramsFromForm(form), "Admin password is incorrect."), 401);
  }

  const redirectUri = field(form, "redirect_uri");
  const state = field(form, "state");
  const codeChallenge = field(form, "code_challenge");
  const clientId = field(form, "client_id") ?? "";
  const upstreamUrl = field(form, "upstream_url");
  const headerNameRaw = field(form, "header_name")?.trim();
  const headerName = headerNameRaw || "Authorization";
  const headerValue = field(form, "header_value");

  if (!redirectUri || !codeChallenge || !upstreamUrl || !headerValue) {
    return html(consentPage(paramsFromForm(form), "All fields are required."), 400);
  }
  try {
    new URL(upstreamUrl);
  } catch {
    return html(consentPage(paramsFromForm(form), "Upstream URL is invalid."), 400);
  }

  const stored: StoredCode = {
    code_challenge: codeChallenge,
    client_id: clientId,
    redirect_uri: redirectUri,
    upstream_url: upstreamUrl,
    header_name: headerName,
    header_value: headerValue,
  };
  const code = randomHex(32);
  await env.KV.put(`code:${code}`, JSON.stringify(stored), { expirationTtl: TTL_CODE });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const grantType = field(form, "grant_type");

  if (grantType === "authorization_code") {
    const code = field(form, "code");
    const verifier = field(form, "code_verifier");
    if (!code || !verifier) return json({ error: "invalid_request" }, 400);

    const stored = await env.KV.get<StoredCode>(`code:${code}`, "json");
    if (!stored) return json({ error: "invalid_grant" }, 400);
    if (!(await verifyPkce(verifier, stored.code_challenge))) {
      return json({ error: "invalid_grant" }, 400);
    }
    await env.KV.delete(`code:${code}`);

    const assoc: Association = {
      upstream_url: stored.upstream_url,
      header_name: stored.header_name,
      header_value: stored.header_value,
    };
    const accessToken = randomHex(40);
    const refreshToken = randomHex(40);
    await env.KV.put(`token:${accessToken}`, JSON.stringify(assoc), { expirationTtl: TTL_ACCESS });
    await env.KV.put(`refresh:${refreshToken}`, JSON.stringify(assoc), {
      expirationTtl: TTL_REFRESH,
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TTL_ACCESS,
      refresh_token: refreshToken,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = field(form, "refresh_token");
    if (!refreshToken) return json({ error: "invalid_request" }, 400);
    const assoc = await env.KV.get<Association>(`refresh:${refreshToken}`, "json");
    if (!assoc) return json({ error: "invalid_grant" }, 400);

    const accessToken = randomHex(40);
    await env.KV.put(`token:${accessToken}`, JSON.stringify(assoc), { expirationTtl: TTL_ACCESS });
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TTL_ACCESS,
    });
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
}

function paramsFromForm(form: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of [
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "upstream_url",
    "header_name",
  ]) {
    const v = form.get(key);
    if (typeof v === "string") params.set(key, v);
  }
  return params;
}
