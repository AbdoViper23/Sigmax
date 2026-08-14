// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // The Story SDK (@story-protocol/core-sdk) and its deps expect Node builtins (process.cwd,
  // path.resolve, …) at runtime. Polyfill them for the browser so /leader registration works.
  // NB: `stream` is intentionally excluded — aliasing it to stream-browserify breaks TanStack's
  // SSR build (which imports the real `stream/web`).
  plugins: [
    nodePolyfills({
      include: ["path", "process", "os", "util", "buffer", "crypto", "events"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  vite: {
    server: {
      /*
       * Same-origin passthrough to the enclave. The browser cannot talk to the FCC proxy directly:
       * it serves no CORS headers, so the response to a cross-origin read is unreadable, and when it
       * is published through ngrok a browser-UA request gets the HTML interstitial instead of JSON.
       * Adding a skip header only converts that into a preflight the proxy also rejects. Proxying
       * here sidesteps all three — the request leaves the dev server, where none of it applies.
       *
       * `/enclave/state` must come first: `/state` lives on the extension's own port, not the FCC
       * proxy's, and the proxy answers it with a bare 404 (which reads exactly like "no key injected").
       */
      proxy: {
        "/enclave/state": {
          target: process.env.ENCLAVE_STATE_TARGET ?? "http://localhost:7702",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/enclave/, ""),
        },
        "/enclave": {
          target: process.env.ENCLAVE_PROXY_TARGET ?? "http://localhost:6674",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/enclave/, ""),
          headers: { "ngrok-skip-browser-warning": "1" },
        },
      },
    },
  },
});
