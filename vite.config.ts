import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve("client/src") } },
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
