import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // The Rust server rebuilds on its own (cargo); don't reload the page for it.
      ignored: ["**/server/**"],
    },
    // In `yarn dev` the API lives on the local `server/` (cargo run, default
    // 127.0.0.1:8787) and is reached same-origin. PONTOSCAN_API_PROXY lets
    // several local servers run side by side.
    proxy: {
      "/api": process.env.PONTOSCAN_API_PROXY ?? "http://127.0.0.1:8787",
    },
  },
}));
