import type { PulseClient } from "./client.js";

// Catches errors nobody caught, in Node and in browsers. Returns a function that removes them.
export function installGlobalHandlers(client: PulseClient): () => void {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    return installBrowserHandlers(client);
  }
  if (typeof process !== "undefined" && typeof process.on === "function") {
    return installNodeHandlers(client);
  }
  return () => {};
}

function installBrowserHandlers(client: PulseClient) {
  const onError = (event: ErrorEvent) => {
    client.captureException(event.error ?? event.message, { level: "fatal" });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    client.captureException(event.reason, { level: "error" });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

// Node's default for both is: print the error and exit with code 1.
// Adding a listener turns that default off, so we report first and then do the same
// thing ourselves. Pulse doesn't change how your app behaves; it just reports.
// If the app has its own listeners too, we leave the decision to them.
function installNodeHandlers(client: PulseClient) {
  const reportAndExit = (event: "uncaughtException" | "unhandledRejection") => {
    return async (error: unknown) => {
      client.captureException(error, { level: "fatal", tags: { mechanism: event } });
      if (process.listenerCount(event) > 1) return;
      console.error(error);
      await client.flush(2_000);
      process.exit(1);
    };
  };

  const onException = reportAndExit("uncaughtException");
  const onRejection = reportAndExit("unhandledRejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
