import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // stellar-sdk expects Node's `global`; the Buffer polyfill is installed in src/main.tsx.
  define: { global: "globalThis" },
  server: { port: 5174 },
});
