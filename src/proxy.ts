import type { Env } from "./index";
import type { Association } from "./oauth";

const STRIP_HEADERS = [
  "host",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
];

export async function handleProxy(
  request: Request,
  env: Env,
  origin: string,
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return unauthorized(origin);

  const assoc = await env.KV.get<Association>(`token:${token}`, "json");
  if (!assoc) return unauthorized(origin);

  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.set(assoc.header_name, assoc.header_value);
  for (const h of STRIP_HEADERS) upstreamHeaders.delete(h);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstreamResp = await fetch(assoc.upstream_url, {
    method: request.method,
    headers: upstreamHeaders,
    body: hasBody ? request.body : null,
  });

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: upstreamResp.headers,
  });
}

function unauthorized(origin: string): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}
