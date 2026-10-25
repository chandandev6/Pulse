import { gunzipSync } from "node:zlib";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { StackFrame } from "@pulse/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { sourceMaps } from "../db/schema.js";
import type { EventJob } from "../events/queue.js";

// "https://shop.com/assets/index-abc.js?v=2" → "index-abc.js": how frames find their map
export function minifiedName(filename: string) {
  const path = filename.split(/[?#]/)[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1);
}

// Map sources are often written relative to the map ("../../src/App.tsx") or with a
// bundler prefix ("webpack://shop/./src/App.tsx"). Show them as plain project paths.
export function cleanSource(source: string) {
  return source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/^\/?@fs\//, "/");
}

// Parsed maps are kept in memory: parsing a big map takes longer than using it, and the
// same release keeps sending errors. Maps missing for a release are remembered for a
// minute only, because CI may upload them a little after the release starts reporting.
const MAX_CACHED = 50;
const MISSING_TTL_MS = 60_000;
const cache = new Map<string, TraceMap | { missingUntil: number }>();

function remember(key: string, value: TraceMap | { missingUntil: number }) {
  cache.delete(key); // re-insert so it counts as the newest
  cache.set(key, value);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function loadMaps(projectId: string, release: string, names: string[]) {
  const maps = new Map<string, TraceMap>();
  const toLoad: string[] = [];

  for (const name of names) {
    const cached = cache.get(`${projectId}|${release}|${name}`);
    if (cached instanceof TraceMap) maps.set(name, cached);
    else if (!cached || cached.missingUntil < Date.now()) toLoad.push(name);
  }
  if (toLoad.length === 0) return maps;

  const rows = await db
    .select({ name: sourceMaps.name, content: sourceMaps.content })
    .from(sourceMaps)
    .where(
      and(
        eq(sourceMaps.projectId, projectId),
        eq(sourceMaps.release, release),
        inArray(sourceMaps.name, toLoad),
      ),
    );
  for (const name of toLoad) {
    const key = `${projectId}|${release}|${name}`;
    const row = rows.find((r) => r.name === name);
    if (!row) {
      remember(key, { missingUntil: Date.now() + MISSING_TTL_MS });
      continue;
    }
    try {
      const map = new TraceMap(gunzipSync(row.content).toString("utf8"));
      remember(key, map);
      maps.set(name, map);
    } catch {
      remember(key, { missingUntil: Date.now() + MISSING_TTL_MS }); // checked on upload, but just in case
    }
  }
  return maps;
}

function translate(frame: StackFrame, map: TraceMap): StackFrame {
  if (!frame.lineno || !frame.colno) return frame;
  // Browsers count columns from 1, source maps from 0
  const original = originalPositionFor(map, { line: frame.lineno, column: frame.colno - 1 });
  if (original.source === null || original.line === null) return frame;

  const filename = cleanSource(original.source);
  return {
    filename,
    function: original.name ?? frame.function,
    lineno: original.line,
    colno: original.column + 1,
    in_app: !filename.includes("node_modules/"),
    minified: {
      filename: frame.filename,
      function: frame.function,
      lineno: frame.lineno,
      colno: frame.colno,
    },
  };
}

// Runs in the event worker before grouping, so the same crash in two releases (two
// different minified bundles) lands in the same issue. Without a release or a matching
// map, the event is returned unchanged.
export async function symbolicate(job: EventJob): Promise<EventJob> {
  const { event, projectId } = job;
  const frames = event.exception?.stacktrace?.frames;
  if (!event.release || !event.exception || !frames?.length) return job;

  const names = [
    ...new Set(
      frames
        .filter((f) => f.filename && f.colno && !f.minified)
        .map((f) => minifiedName(f.filename ?? "")),
    ),
  ].filter(Boolean);
  if (names.length === 0) return job;

  const maps = await loadMaps(projectId, event.release, names);
  if (maps.size === 0) return job;

  const translated = frames.map((frame) => {
    const map = frame.filename && !frame.minified && maps.get(minifiedName(frame.filename));
    return map ? translate(frame, map) : frame;
  });

  return {
    ...job,
    event: {
      ...event,
      exception: { ...event.exception, stacktrace: { frames: translated } },
    },
  };
}

export function clearSourceMapCache() {
  cache.clear();
}
