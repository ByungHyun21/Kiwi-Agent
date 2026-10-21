import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// dev: vite dev server proxies /api and /ws to the local kiwi-server
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:5494",
      "/ws": { target: "ws://localhost:5494", ws: true },
    },
  },
});
