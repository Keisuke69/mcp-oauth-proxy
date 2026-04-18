import {
  discoveryAuthorizationServer,
  discoveryProtectedResource,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
} from "./oauth";
import { handleProxy } from "./proxy";

export interface Env {
  KV: KVNamespace;
  ADMIN_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (
        path === "/.well-known/oauth-protected-resource" ||
        path.startsWith("/.well-known/oauth-protected-resource/")
      ) {
        return discoveryProtectedResource(url.origin);
      }

      if (path === "/.well-known/oauth-authorization-server") {
        return discoveryAuthorizationServer(url.origin);
      }

      if (path === "/register" && request.method === "POST") {
        return await handleRegister(request);
      }

      if (path === "/authorize" && request.method === "GET") {
        return handleAuthorizeGet(url);
      }

      if (path === "/authorize" && request.method === "POST") {
        return await handleAuthorizePost(request, env);
      }

      if (path === "/token" && request.method === "POST") {
        return await handleToken(request, env);
      }

      if (path === "/mcp" || path.startsWith("/mcp/")) {
        return await handleProxy(request, env, url.origin);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Internal error: ${message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
