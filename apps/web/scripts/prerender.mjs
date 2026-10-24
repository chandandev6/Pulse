// Runs after "vite build": puts the landing page's HTML inside a copy of index.html, as
// dist/landing.html. nginx serves that file for "/", so search engines and link previews see
// the real text instead of an empty <div id="root">. Every other path still gets index.html.
import { readFile, rm, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const ssr = new URL("../dist-ssr/", import.meta.url);

const { renderLanding } = await import(new URL("prerender.js", ssr).href);
const template = await readFile(new URL("index.html", dist), "utf8");

const placeholder = '<div id="root"></div>';
if (!template.includes(placeholder)) throw new Error(`${placeholder} not found in index.html`);

await writeFile(
  new URL("landing.html", dist),
  template.replace(placeholder, `<div id="root">${renderLanding()}</div>`),
);
await rm(ssr, { recursive: true, force: true });
console.log("prerendered dist/landing.html");
