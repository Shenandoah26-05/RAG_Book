import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createApiClient } from "./api/client.js";
import { openPdf } from "./pdf/open-pdf.js";
import { browserStorage } from "./reader/position.js";
import "./styles.css";

/**
 * `/api` in development, where Vite forwards it to `pnpm api`. For a build served from somewhere
 * else, set `VITE_API_URL` (e.g. `http://127.0.0.1:8787`) when building; the API must then allow
 * the page's origin (`pnpm api --origin <url>`).
 */
const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const client = createApiClient({ baseUrl });

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App
      client={client}
      openPdf={openPdf}
      storage={browserStorage()}
      doc={new URLSearchParams(window.location.search).get("doc") ?? undefined}
    />
  </StrictMode>,
);
