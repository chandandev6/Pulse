import { createHash } from "node:crypto";
import type { PulseEvent, StackFrame } from "@pulse/shared";

// A fingerprint answers "is this the same problem?". Events with the same
// fingerprint are grouped into one issue. So it must ignore what changes between
// occurrences (line numbers, ids in messages, build hashes) and keep what doesn't
// (error type, which functions crashed).

// "https://cdn.shop.com/assets/app.3f9a1c2b.js?v=2" → "/assets/app.js"
export function normalizeFilename(filename: string): string {
  return filename
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") // origin: https://cdn.shop.com, webpack://app
    .replace(/[?#].*$/, "") // query string and hash
    .replace(/[.-][a-f0-9]{8,}(?=\.[a-z]+$)/i, ""); // build hash before the extension
}

// "Order 1234 for 'ada' failed (id 3f2a...)" → "Order <num> for <str> failed (id <uuid>)"
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(?<!\w)(["'`])(?:(?!\1).)*\1/g, "<str>") // (?<!\w): not the ' in "can't"
    .replace(/\d+(\.\d+)?/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function frameKey(frame: StackFrame): string {
  // No line or column numbers: adding one line above the bug shouldn't create a new issue
  return `${frame.filename ? normalizeFilename(frame.filename) : "?"}:${frame.function ?? "?"}`;
}

// The frames that describe *where* it broke. Prefer the app's own code (in_app),
// because library internals look the same for many different bugs.
export function groupingFrames(event: PulseEvent): StackFrame[] {
  const frames = (event.exception?.stacktrace?.frames ?? []).filter(
    (f) => f.function || f.filename,
  );
  const appFrames = frames.filter((f) => f.in_app !== false);
  return appFrames.length > 0 ? appFrames : frames;
}

// The human-readable ingredients, before hashing. Useful in tests and for debugging.
export function fingerprintParts(event: PulseEvent): string[] {
  if (event.fingerprint) {
    return ["custom", ...event.fingerprint];
  }

  const type = event.exception?.type ?? "";
  const frames = groupingFrames(event);
  if (frames.length > 0) {
    return ["stack", type, ...frames.map(frameKey)];
  }

  return ["message", type, normalizeMessage(event.exception?.value ?? event.message ?? "")];
}

export function computeFingerprint(event: PulseEvent): string {
  return createHash("sha256").update(fingerprintParts(event).join("\n")).digest("hex");
}
