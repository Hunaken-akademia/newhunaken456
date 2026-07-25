import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // cloud-bootstrap-v3.js uses top-level await before importing the app bundle.
    // Keep the existing bootstrap flow and emit modern ESM instead of rewriting auth/cloud startup.
    target: "esnext",
  },
});
