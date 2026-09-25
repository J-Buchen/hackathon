import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA. No backend/proxy: the app only reads /demo-snapshot.json from
// the public/ directory (served at the web root), so it works fully offline.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: false },
  build: {
    outDir: "dist",
    // ESM-everywhere invariant → no need to transpile down to legacy targets.
    target: "es2020",
    // Keep source maps for error tooling, but 'hidden' drops the trailing
    // //# sourceMappingURL comment so browsers don't fetch maps on every load.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Split heavy vendors into their own chunks: React stays cacheable
        // across deploys, and the motion/lenis chunks download in parallel
        // instead of blocking behind one monolithic vendor blob.
        manualChunks: {
          react: ["react", "react-dom"],
          motion: ["framer-motion"],
          lenis: ["lenis"],
        },
      },
    },
  },
});
