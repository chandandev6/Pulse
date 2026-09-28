import { config } from "./config.js";

function buildLoggerOptions() {
  if (config.NODE_ENV === "test") {
    return false;
  }

  if (config.NODE_ENV === "production") {
    return { level: "info" };
  }

  return {
    level: "debug",
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  };
}

export const loggerOptions = buildLoggerOptions();
