import type { StackFrame } from "@pulse/shared";

const MAX_FRAMES = 100;

// Chrome, Edge and Node (V8):
//   "    at checkout (/srv/app/src/cart.js:42:7)"
//   "    at async Promise.all (index 0)"            ← no location, skipped
//   "    at /srv/app/src/server.js:10:3"            ← anonymous function
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

// Firefox and Safari:
//   "checkout@https://shop.com/cart.js:42:7"
//   "@https://shop.com/app.js:10:3"
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

function cleanFunction(name: string | undefined): string | undefined {
  const cleaned = name
    ?.replace(/^async /, "")
    .replace(/^new /, "")
    .replace(/ \[as \w+\]$/, "")
    .trim();
  return cleaned || undefined;
}

function cleanFilename(filename: string): string {
  return filename.replace(/^file:\/\//, "");
}

// Our own code, or something we didn't write (libraries, Node internals, the browser)?
export function isInApp(filename: string): boolean {
  return !(
    filename.includes("/node_modules/") ||
    filename.startsWith("node:") ||
    filename.startsWith("internal/") ||
    filename === "native" ||
    filename.startsWith("<")
  );
}

// Turns error.stack text into frames, oldest call first and the crash last
// (stacks list the newest call first, so we reverse them).
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = line.match(V8_FRAME) ?? (line.includes("@") ? line.match(GECKO_FRAME) : null);
    if (!match) continue; // the "TypeError: message" line, or a frame with no location

    const [, fn, file, lineno, colno] = match;
    if (!file) continue;
    const filename = cleanFilename(file);
    frames.push({
      function: cleanFunction(fn),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: isInApp(filename),
    });
  }

  // Keep the frames closest to the crash if the stack is huge
  return frames.reverse().slice(-MAX_FRAMES);
}
