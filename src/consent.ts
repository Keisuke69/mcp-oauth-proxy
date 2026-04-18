const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function consentPage(params: URLSearchParams, error = ""): string {
  const clientId = esc(params.get("client_id"));
  const redirectUri = esc(params.get("redirect_uri"));
  const state = esc(params.get("state"));
  const codeChallenge = esc(params.get("code_challenge"));
  const upstreamUrl = esc(params.get("upstream_url"));
  const headerName = esc(params.get("header_name") || "Authorization");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize MCP Proxy</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 20px; color: #222; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  p.lead { color: #666; font-size: 14px; margin-top: 0; }
  label { display: block; margin: 16px 0 6px; font-size: 13px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; font-family: inherit; }
  input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; border-color: transparent; }
  .hint { font-size: 12px; color: #777; margin-top: 4px; }
  button { margin-top: 24px; width: 100%; padding: 12px; background: #111; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #000; }
  .error { background: #fee2e2; color: #7f1d1d; padding: 10px 12px; border-radius: 8px; margin: 16px 0; font-size: 13px; }
</style>
</head>
<body>
  <h1>Authorize MCP Proxy</h1>
  <p class="lead">Connect an upstream MCP server. Credentials are stored in Workers KV and used only for proxying your own requests.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">

    <label>Upstream MCP URL</label>
    <input type="url" name="upstream_url" required placeholder="https://example.com/mcp" value="${upstreamUrl}">

    <label>Auth Header Name</label>
    <input type="text" name="header_name" value="${headerName}">
    <div class="hint">e.g. "Authorization" (default) or "X-API-Key"</div>

    <label>Auth Header Value</label>
    <input type="password" name="header_value" required placeholder="Bearer xxxxx">
    <div class="hint">For Bearer auth include the "Bearer " prefix. For API keys, the raw key.</div>

    <label>Admin Password</label>
    <input type="password" name="admin_secret" required>
    <div class="hint">The ADMIN_SECRET set on this Worker. Prevents others from using your proxy.</div>

    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}
