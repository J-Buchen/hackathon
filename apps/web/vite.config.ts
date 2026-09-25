import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA. No backend/proxy: the app only reads /demo-snapshot.json from
// the public/ directory (served at the web root), so it works fully offline.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: false },
  build: { outDir: "dist", sourcemap: true },
});
