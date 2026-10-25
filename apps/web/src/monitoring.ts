import Pulse from "@pulse/sdk";

// Pulse watching Pulse: the dashboard reports its own crashes when it was built with
// VITE_PULSE_DSN (PULSE_WEB_DSN in docker-compose.prod.yml). Unset = nothing is sent.
export function startMonitoring() {
  const dsn = import.meta.env.VITE_PULSE_DSN;
  if (!dsn) return;
  Pulse.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_PULSE_RELEASE || undefined,
  });
  Pulse.setTag("service", "web");
}
