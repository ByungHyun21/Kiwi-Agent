import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// the SPA imports src/shared/protocol.ts from outside web/
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// dev: vite dev server proxies /api and /ws to the local kiwi-server
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": "http://localhost:5494",
      "/ws": { target: "ws://localhost:5494", ws: true },
    },
  },
});
