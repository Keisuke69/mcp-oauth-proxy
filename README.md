# mcp-oauth-proxy

An OAuth 2.1 facade proxy for Bearer / header-auth MCP servers, running on Cloudflare Workers.

*[日本語 README はこちら / Japanese README →](README.ja.md)*

## What this is

[Claude.ai Custom Connectors](https://support.anthropic.com/en/articles/11175166) can only connect to remote MCP servers that speak **OAuth 2.1 + PKCE**. Lots of real-world MCP servers, however, authenticate with a fixed Bearer token or an API key header (for example [Twilog MCP](https://twilog.togetter.com/mcp)). On Claude Desktop you can bridge them with [`mcp-remote`](https://github.com/geelen/mcp-remote) and a local Node.js process, but that does not work on the mobile app or on claude.ai in the browser.

`mcp-oauth-proxy` is a tiny Cloudflare Worker that sits between Claude and such an MCP server. From Claude's perspective it is a normal OAuth 2.1 MCP server; internally it terminates the OAuth handshake, stores your upstream credentials in Workers KV, and then proxies `/mcp` requests upstream with the correct authentication header swapped in.

- Zero runtime dependencies — just the Workers built-ins and Web Crypto.
- One Worker deploy can front any number of upstream MCP servers.
- Works from every Claude surface (web, desktop, mobile) because there is no local bridge.

## How it works

```
┌──────────┐  OAuth 2.1 + PKCE  ┌──────────────────┐  Bearer / X-API-Key  ┌──────────────────┐
│ Claude   │ ─────────────────► │ mcp-oauth-proxy  │ ───────────────────► │ upstream MCP svr │
│ (web/    │ ◄───────────────── │ (Cloudflare      │ ◄─────────────────── │ (Twilog, etc.)   │
│ desktop/ │   access_token     │  Worker + KV)    │    MCP response       │                  │
│ mobile)  │                    └──────────────────┘                       └──────────────────┘
└──────────┘
```

When you complete the OAuth consent form, the Worker stores `{upstream_url, header_name, header_value}` against the issued `access_token` in KV. Every subsequent `/mcp` request from Claude is authenticated by that access token, and the request is rewritten with the stored upstream header before being forwarded.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource` (and sub-paths) | RFC 9728 resource metadata |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| POST | `/register` | RFC 7591 Dynamic Client Registration |
| GET | `/authorize` | HTML consent form |
| POST | `/authorize` | Submit consent, issue authorization code |
| POST | `/token` | Exchange code (PKCE) or refresh token for access token |
| * | `/mcp`, `/mcp/*` | Authenticated proxy to the upstream MCP server |

PKCE S256 is the only supported challenge method. The proxy is a public client (`token_endpoint_auth_methods_supported: ["none"]`).

## Quick start (Cloudflare Dashboard, no Wrangler required)

1. **Create a KV namespace** — Workers & Pages → KV → Create namespace (name it anything). Copy the ID.
2. **Create a Worker** — Workers & Pages → Create → Create Worker. Paste a bundled build of this repo (or just the contents of `src/` via the quick editor). Save & Deploy.
3. **Bind the KV namespace** — open the Worker → Settings → Variables → KV Namespace Bindings → Add. Use **binding name `KV`** and pick the namespace from step 1.
4. **Set the admin password** — same Settings page → Variables → Environment Variables → Add. Use **variable name `ADMIN_SECRET`** and mark it as a **Secret**. Choose a strong password.
5. **Note your worker URL** — something like `https://mcp-oauth-proxy.<your-subdomain>.workers.dev`.

### Quick start (Wrangler)

```bash
git clone https://github.com/<you>/mcp-oauth-proxy.git
cd mcp-oauth-proxy
npm install

# Create the KV namespace and paste the returned id into wrangler.toml
npx wrangler kv namespace create KV

# Set the admin password (prompts for input)
npx wrangler secret put ADMIN_SECRET

# Deploy
npx wrangler deploy
```

## Register it in Claude.ai

1. In Claude, open **Settings → Connectors → Custom connectors → Add custom connector**.
2. URL: `https://<your-worker>/mcp`.
3. Claude will perform OAuth discovery, register a client, and redirect you to the Worker's consent page.
4. Fill in:
   - **Upstream MCP URL** — the real MCP server you want to reach, e.g. `https://twilog-mcp.example/mcp`.
   - **Auth Header Name** — usually `Authorization` (default) or `X-API-Key`.
   - **Auth Header Value** — for Bearer auth include the literal `Bearer ` prefix; for API keys just the key.
   - **Admin Password** — the `ADMIN_SECRET` you configured on the Worker.
5. Submit. Claude completes the PKCE exchange and the connector is ready.

## Fronting multiple upstream MCP servers

One Worker can proxy any number of different upstream MCPs. Each Custom Connector registration runs an independent OAuth flow and gets its own `access_token`, which maps to its own upstream in KV.

Claude deduplicates connectors by URL, so give each one a unique query string:

```
https://<your-worker>/mcp?name=twilog
https://<your-worker>/mcp?name=linear
https://<your-worker>/mcp?name=notion
```

The Worker itself **ignores** the query string — it's purely a Claude-side disambiguator.

## Security notes

- `ADMIN_SECRET` is the only gate on the consent page. Without it, anyone who can find your Worker URL could create their own upstream mapping and have the Worker proxy arbitrary requests on their behalf. **Use a strong, unique value and treat it like a password.**
- Upstream credentials are stored in Workers KV **in plaintext**. If your Cloudflare account is compromised, those secrets are readable. KV is access-controlled at the account level — protect your Cloudflare account accordingly (SSO / 2FA).
- Authorization codes are one-time and expire in 10 minutes.
- Access tokens expire in 1 hour; refresh tokens expire in 30 days.
- The proxy only supports PKCE S256 and only `authorization_code` / `refresh_token` grants.
- TLS is terminated by Cloudflare; `https://` is required end-to-end.

## Known limitations

- **Authorization header leakage** when `header_name` is not `Authorization`. The proxy sets the configured upstream header, but the inbound `Authorization: Bearer <access_token>` header is *not* stripped, so the upstream will see the proxy's own access token in `Authorization`. This is harmless for most upstreams (the token is opaque and scoped to the proxy), but be aware of it.
- No refresh-token rotation: the same refresh token can be exchanged repeatedly until it expires.
- No revocation or introspection endpoints.
- No per-token rate limiting; the Cloudflare account-level limits apply.
- No audit log beyond Cloudflare's built-in request logs.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest + @cloudflare/vitest-pool-workers
npm run deploy:dry     # wrangler deploy --dry-run
```

Project layout:

```
src/
  index.ts       fetch handler / router (defines Env)
  oauth.ts       OAuth endpoints (discovery, register, authorize, token; defines Association, StoredCode)
  proxy.ts       /mcp proxy
  consent.ts     HTML consent form
  util.ts        json()/html() helpers, PKCE S256, random generators
test/
  crypto.test.ts
  oauth.test.ts
  proxy.test.ts
```

## Contributing

Issues and pull requests are welcome. Keep the Worker runtime-dependency-free (no frameworks, no Node built-ins).

## License

[MIT](LICENSE).
