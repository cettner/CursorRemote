import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives this dev server, so the port is fixed and failures must be loud
// rather than silently shifting to another port the Rust side is not watching.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
