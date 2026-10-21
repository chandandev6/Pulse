import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The dashboard calls the API through "/backend/...". Vite forwards those requests
// to the API, so the browser sees one origin: cookies just work and no CORS is needed.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, "../..", ""), ...process.env }; // the repo's root .env
  const target = env.PULSE_API_URL ?? `http://localhost:${env.API_PORT ?? 3000}`;
  const proxy = {
    "/backend": { target, rewrite: (path: string) => path.replace(/^\/backend/, "") },
  };

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  };
});
