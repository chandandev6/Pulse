import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter } from "react-router";
import { App, createQueryClient } from "./App";
import { routes } from "./routes";

// Built with "vite build --ssr" and called by scripts/prerender.mjs: the landing page as HTML.
// It renders the logged-out state (no API calls happen on the server).
export function renderLanding() {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  return renderToString(
    <StrictMode>
      <App router={router} queryClient={createQueryClient()} />
    </StrictMode>,
  );
}
