# mcp-oauth-proxy

Bearer トークンや任意ヘッダで認証するリモート MCP サーバーに対して、OAuth 2.1 のファサードを提供する Cloudflare Workers プロキシ。

*[English README →](README.md)*

## 解決したい問題

[claude.ai の Custom Connector](https://support.anthropic.com/ja/articles/11175166) は **OAuth 2.1 + PKCE** でのみリモート MCP サーバーに接続できる。一方で実在するリモート MCP サーバーの多くは、固定 Bearer トークンや API Key ヘッダで認証する方式を取っている（例: [Twilog MCP](https://twilog.togetter.com/mcp)）。Claude Desktop なら [`mcp-remote`](https://github.com/geelen/mcp-remote) を経由してローカル Node.js で橋渡しできるが、モバイルアプリやブラウザ版 claude.ai では使えない。

`mcp-oauth-proxy` は Claude と上流 MCP サーバーの間に立つ小さな Cloudflare Worker。Claude から見れば普通の OAuth 2.1 MCP サーバーに見えるが、内部では OAuth ハンドシェイクを処理し、Workers KV に上流の資格情報を保存し、以降の `/mcp` リクエストを正しい認証ヘッダに詰め替えて上流に転送する。

- 外部依存ゼロ — Workers 組み込み API と Web Crypto のみ。
- 1 つの Worker デプロイで任意の数の上流 MCP を束ねられる。
- ローカルランタイムが不要なので、Claude のあらゆる面（Web / Desktop / モバイル）から動く。

## 仕組み

```
┌──────────┐  OAuth 2.1 + PKCE  ┌──────────────────┐  Bearer / X-API-Key  ┌──────────────────┐
│ Claude   │ ─────────────────► │ mcp-oauth-proxy  │ ───────────────────► │ 上流 MCP サーバー │
│ (Web /   │ ◄───────────────── │ (Cloudflare      │ ◄─────────────────── │ (Twilog 等)      │
│ Desktop/ │   access_token     │  Worker + KV)    │    MCP レスポンス     │                  │
│ モバイル)│                    └──────────────────┘                       └──────────────────┘
└──────────┘
```

同意画面を送信すると、Worker は `{upstream_url, header_name, header_value}` を発行した `access_token` に紐付けて KV に保存する。以降 Claude から来る `/mcp` リクエストはその access_token で認証され、設定済みの上流ヘッダに詰め替えられて転送される。

## エンドポイント一覧

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource`（および配下） | RFC 9728 Protected Resource メタデータ |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 Authorization Server メタデータ |
| POST | `/register` | RFC 7591 Dynamic Client Registration |
| GET | `/authorize` | HTML 同意フォームを返す |
| POST | `/authorize` | 同意フォーム submit を受けて認可コードを発行 |
| POST | `/token` | 認可コード（PKCE）またはリフレッシュトークンをアクセストークンに交換 |
| * | `/mcp`, `/mcp/*` | 上流 MCP サーバーへの認証済みプロキシ |

PKCE は S256 のみサポート。public client として扱い、`token_endpoint_auth_methods_supported: ["none"]`。

## クイックスタート（Cloudflare Dashboard, Wrangler 不要）

1. **KV Namespace を作成** — Workers & Pages → KV → Create namespace（名前は任意）。ID をメモ。
2. **Worker を作成** — Workers & Pages → Create → Create Worker。このリポジトリをビルドしたものを貼り付ける（または `src/` の内容を Quick Editor にペースト）。Save & Deploy。
3. **KV Namespace を bind** — Worker → Settings → Variables → KV Namespace Bindings → Add。**binding 名は `KV`**、namespace は手順 1 のもの。
4. **管理パスワードを設定** — 同じ Settings → Variables → Environment Variables → Add。**変数名 `ADMIN_SECRET`**、**Secret として登録**。強いパスワードを使うこと。
5. **Worker の URL を控える** — `https://mcp-oauth-proxy.<your-subdomain>.workers.dev` のような形。

### クイックスタート（Wrangler 利用）

```bash
git clone https://github.com/<you>/mcp-oauth-proxy.git
cd mcp-oauth-proxy
npm install

# KV namespace を作成し、出力された id を wrangler.toml に貼り付ける
npx wrangler kv namespace create KV

# 管理パスワードを Secret としてセット（対話入力）
npx wrangler secret put ADMIN_SECRET

# デプロイ
npx wrangler deploy
```

## claude.ai への Custom Connector 登録

1. Claude の **設定 → コネクター → Custom connectors → Add custom connector** を開く。
2. URL に `https://<your-worker>/mcp` を入力。
3. Claude が OAuth ディスカバリとクライアント登録を行い、Worker の同意画面にリダイレクトされる。
4. 同意画面で入力:
   - **Upstream MCP URL** — 接続したい本物の MCP サーバーの URL（例: `https://twilog-mcp.example/mcp`）
   - **Auth Header Name** — 通常 `Authorization`（デフォルト）または `X-API-Key`
   - **Auth Header Value** — Bearer 認証なら `Bearer ` プレフィックス込みで。API Key ならキーそのもの。
   - **Admin Password** — Worker にセットした `ADMIN_SECRET`
5. Submit。Claude 側で PKCE 交換が完了し、コネクターが使えるようになる。

## 複数の上流 MCP を束ねる

1 つの Worker デプロイで任意の数の上流 MCP をプロキシできる。Custom Connector を登録するたびに独立した OAuth フローが走り、独立した `access_token` と上流マッピングが KV に保存される。

claude.ai は URL で連携を重複判定するので、クエリで区別させる:

```
https://<your-worker>/mcp?name=twilog
https://<your-worker>/mcp?name=linear
https://<your-worker>/mcp?name=notion
```

Worker 側はこのクエリを**無視する**。あくまで Claude 側で別コネクタとして扱わせるためのマーカー。

## セキュリティ上の注意

- 同意画面の唯一のゲートが `ADMIN_SECRET`。これが漏れると、Worker の URL を知っている誰でもが自分の上流マッピングを登録し、任意の宛先をプロキシさせられる。**十分に強くユニークな値を使い、パスワードとして扱うこと。**
- 上流の資格情報は Workers KV に**平文で保存される**。Cloudflare アカウントが侵害されると読み取られる。KV はアカウント単位でアクセス制御されるため、Cloudflare アカウントの SSO / 2FA での保護が前提になる。
- 認可コードは 1 回限り、有効期限は 10 分。
- Access token は 1 時間、Refresh token は 30 日で失効。
- サポートするのは PKCE S256 および `authorization_code` / `refresh_token` grant のみ。
- TLS は Cloudflare が終端する。`https://` 必須。

## 既知の制約

- **`header_name` が `Authorization` でない場合の Authorization ヘッダ漏洩**: プロキシは設定された上流ヘッダをセットするが、Claude から送られてきた `Authorization: Bearer <access_token>` ヘッダはそのまま上流に届く。上流にとってはこのトークンは意味のない不透明値なので実害は小さいが、留意されたい。
- Refresh token のローテーションなし: 期限切れまで同じ refresh token を何度でも交換できる。
- トークン revocation / introspection エンドポイント未提供。
- トークン単位のレート制限なし（Cloudflare のアカウント単位制限のみ適用）。
- Cloudflare のリクエストログ以上の監査ログはない。

## 開発

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest + @cloudflare/vitest-pool-workers
npm run deploy:dry     # wrangler deploy --dry-run
```

ディレクトリ構成:

```
src/
  index.ts       fetch ハンドラ / ルーター
  oauth.ts       OAuth エンドポイント群 (discovery, register, authorize, token)
  proxy.ts       /mcp プロキシ
  consent.ts     同意画面 HTML
  kv.ts          型付き KV ラッパー
  crypto.ts      PKCE S256 / 乱数生成
  http.ts        json() / html() レスポンスヘルパー
  types.ts       Env, Association, StoredCode
test/
  crypto.test.ts
  oauth.test.ts
  proxy.test.ts
```

## Contributing

Issue と Pull Request を歓迎。Worker ランタイムには依存を追加しない（フレームワーク不可、Node 組み込みモジュール不可）ことを守ってほしい。

## License

[MIT](LICENSE).
