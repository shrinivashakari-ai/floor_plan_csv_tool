import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/cleaner/",
  build: {
    outDir: path.resolve(__dirname, "../static/cleaner"),
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
