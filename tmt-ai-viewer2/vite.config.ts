import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Backend serves the built SPA in prod; in dev, proxy /api to the node server.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8035",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
