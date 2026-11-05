// PROTOTYPE (#10). The dev proxy from research/ui-sdk-embedding.md: the browser
// only ever talks to Vite's origin, and Vite forwards /api to TrueForge.
import { HOST, PORTS, TRUEFORGE_ORIGIN } from "@forge-lab/lib/ports";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // These must resolve to one copy, or the SDK throws "requires an AuiProvider".
    dedupe: ["react", "react-dom", "@assistant-ui/core", "@assistant-ui/react", "@assistant-ui/store"],
  },
  server: {
    host: HOST,
    port: PORTS.vite,
    strictPort: true,
    proxy: {
      "/api": {
        target: TRUEFORGE_ORIGIN,
        changeOrigin: true,
        configure(proxy) {
          // Stop anything between us and the browser from buffering SSE streams.
          proxy.on("proxyRes", (res) => {
            if (res.headers["content-type"]?.includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
