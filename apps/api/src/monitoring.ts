import Pulse from "@pulse/sdk";
import { config } from "./config.js";

// Pulse watching Pulse: the API and the worker send their own crashes to a Pulse project.
// Returns false when PULSE_DSN isn't set (then nothing is reported).
export function startMonitoring(service: "api" | "worker") {
  if (!config.PULSE_DSN) return false;

  Pulse.init({
    dsn: config.PULSE_DSN,
    environment: config.NODE_ENV,
    release: config.PULSE_RELEASE,
    // Never report errors of the ingestion or upload routes. If ingestion itself were broken,
    // each report would fail, be reported, fail again... a loop that floods the server.
    beforeSend: (event) => {
      const path = event.request?.route ?? event.request?.url ?? "";
      return path.startsWith("/api/") ? null : event;
    },
  });
  Pulse.setTag("service", service);
  return true;
}

export { Pulse };
