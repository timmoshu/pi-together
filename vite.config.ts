import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Client build → dist/client (served by the node server as static assets).
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    // dev proxy: client dev server → local api server
    proxy: {
      "/api": "http://127.0.0.1:43117",
      "/events": { target: "http://127.0.0.1:43117", ws: false },
    },
  },
});
