#!/usr/bin/env node
// Uploads every .map file in a build folder to Pulse, for one release. Run it in CI after
// building, with the same release your app passes to Pulse.init({ release }).
//
//   PULSE_UPLOAD_TOKEN=pulse_ut_... node scripts/upload-sourcemaps.mjs \
//     --url https://pulse-log.app --project <project id> --release 1.4.2 [--delete] dist
//
// --delete removes the .map files afterwards, so your web server doesn't publish your
// source code. (Or build with sourcemap: "hidden" and delete them yourself.)
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    url: { type: "string" },
    project: { type: "string" },
    release: { type: "string" },
    token: { type: "string", default: process.env.PULSE_UPLOAD_TOKEN },
    delete: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const dir = positionals[0];
if (!values.url || !values.project || !values.release || !values.token || !dir) {
  console.error(
    "Usage: PULSE_UPLOAD_TOKEN=... upload-sourcemaps.mjs --url <pulse url> --project <id> --release <version> [--delete] <folder>",
  );
  process.exit(2);
}

const files = (await readdir(dir, { recursive: true }))
  .filter((file) => file.endsWith(".map"))
  .map((file) => join(dir, file));
if (files.length === 0) {
  console.error(`No .map files in ${dir}. Did the build make source maps?`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const name = relative(dir, file);
  const query = new URLSearchParams({ release: values.release, name });
  const res = await fetch(`${values.url}/api/${values.project}/sourcemaps?${query}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${values.token}`,
      "content-type": "application/octet-stream",
    },
    body: await readFile(file),
  });
  if (res.ok) {
    console.log(`✓ ${name}`);
    if (values.delete) await rm(file);
  } else {
    failed++;
    console.error(`✗ ${name}: ${res.status} ${await res.text()}`);
  }
}

console.log(`${files.length - failed}/${files.length} uploaded for release ${values.release}`);
process.exit(failed > 0 ? 1 : 0);
