import { PulseClient } from "./client.js";
import { installGlobalHandlers } from "./handlers.js";
import { createExpressErrorHandler, createFastifyPlugin } from "./integrations.js";
import type { CaptureContext, Level, PulseOptions, User } from "./types.js";

export { PulseClient, SDK_NAME, SDK_VERSION } from "./client.js";
export { parseDsn } from "./dsn.js";
export { parseStack } from "./stacktrace.js";
export { createFetchTransport } from "./transport.js";
export type * from "./types.js";

// One global client, so any file can call Pulse.captureException() after init()
let client: PulseClient | undefined;
let removeHandlers: (() => void) | undefined;

export function init(options: PulseOptions): PulseClient {
  removeHandlers?.();
  client = new PulseClient(options);
  if (options.enabled !== false && options.captureUnhandled !== false) {
    removeHandlers = installGlobalHandlers(client);
  }
  return client;
}

// All of these do nothing before init(), so libraries can call them safely
export function captureException(error: unknown, context?: CaptureContext) {
  return client?.captureException(error, context);
}

export function captureMessage(message: string, level?: Level, context?: CaptureContext) {
  return client?.captureMessage(message, level, context);
}

export function setUser(user: User | null) {
  client?.setUser(user);
}

export function setTag(key: string, value: string) {
  client?.setTag(key, value);
}

export function setContext(key: string, value: unknown) {
  client?.setContext(key, value);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return client?.flush(timeoutMs) ?? Promise.resolve(true);
}

// Sends what's left and stops capturing
export async function close(timeoutMs?: number): Promise<boolean> {
  const flushed = await flush(timeoutMs);
  removeHandlers?.();
  removeHandlers = undefined;
  client = undefined;
  return flushed;
}

export const expressErrorHandler = (options?: Parameters<typeof createExpressErrorHandler>[1]) =>
  createExpressErrorHandler(captureException, options);

export const fastifyPlugin = createFastifyPlugin(captureException);

// Lets people write `import Pulse from "@pulse/sdk"` and then `Pulse.init(...)`
const Pulse = {
  init,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setContext,
  flush,
  close,
  expressErrorHandler,
  fastifyPlugin,
};
export default Pulse;
