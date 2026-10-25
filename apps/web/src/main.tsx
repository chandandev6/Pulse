import "@fontsource-variable/host-grotesk";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { startMonitoring } from "./monitoring";

startMonitoring();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// The landing page arrives already rendered (landing.html, see scripts/prerender.mjs):
// reuse that HTML instead of drawing it again. Every other page starts from an empty #root.
if (rootElement.hasChildNodes()) {
  hydrateRoot(rootElement, app);
} else {
  createRoot(rootElement).render(app);
}
