import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp();

async function shutdown(signal: NodeJS.Signals) {
  app.log.info(`${signal} received, shutting down...`);
  await app.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
