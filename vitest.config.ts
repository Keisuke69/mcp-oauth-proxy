import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2025-04-01",
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["KV"],
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
          },
        },
      },
    },
  },
});
