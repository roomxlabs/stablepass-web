import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // e2e/ holds Playwright specs (own `test()`, own runner) — never vitest's.
    // `**/node_modules/**` (not `node_modules/**`) because the loop's per-ticket
    // worktrees under .claude/worktrees/ carry their own node_modules; the
    // top-level-only glob let vitest crawl those and run third-party suites.
    exclude: ["**/node_modules/**", "e2e/**", ".next/**", ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
