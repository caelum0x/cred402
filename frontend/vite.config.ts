import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = process.env.CRED402_API ?? "http://localhost:4021";

// During dev, proxy API + x402 + SSE to the backend. In prod the backend serves
// the built assets directly, so these paths are same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/verify": { target: API, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
