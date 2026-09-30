import { defineConfig } from "vite";

// Tauri expects a fixed dev port and the production assets in dist/.
export default defineConfig({
  clearScreen: false,
  // Zola writes the offline help site under generated/docs. Treating that as
  // Vite's public tree puts it at /docs in both development and frontendDist,
  // where Tauri embeds it alongside the application frontend.
  publicDir: "generated",
  server: {
    port: 1420,
    strictPort: true,
    // Prevent the WebKitGTK webview from serving stale JS in dev.
    headers: { "Cache-Control": "no-store" },
    // HMR can't cleanly re-run module-level side effects (the LSP client's
    // start()); disabling it makes every change a full reload during dev.
    hmr: false,
  },
  build: {
    target: "esnext",
    outDir: "dist",
    // Monaco core is ~2MB; irreducible and fine for a desktop app (no network load).
    chunkSizeWarningLimit: 3000,
  },
});
