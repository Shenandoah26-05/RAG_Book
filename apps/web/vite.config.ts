import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `pnpm api` listens by default (src/api/args.ts). */
const API = "http://127.0.0.1:8787";

// In development the page and the API are on different ports. The page calls `/api/...` on its own
// origin and Vite forwards it, so the browser sees one origin (no CORS), and the `/api` prefix is
// dropped on the way: the API's routes are `/book`, `/pages/:n` and so on.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
});
