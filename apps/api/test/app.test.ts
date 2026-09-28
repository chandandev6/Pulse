import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/errors.js";

const app = buildApp();

// Fake routes that only exist in tests, to trigger errors on purpose
app.get("/boom", async () => {
  throw new Error("secret database password in here");
});
app.get("/teapot", async () => {
  throw new AppError(418, "TEAPOT", "I am a teapot");
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("reports ok when postgres and redis are up", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "ok", redis: "ok" });
  });
});

describe("error handling", () => {
  it("returns JSON 404 for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("uses status and code from AppError", async () => {
    const res = await app.inject({ method: "GET", url: "/teapot" });

    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: { code: "TEAPOT", message: "I am a teapot" } });
  });

  it("hides details of unexpected errors", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
  });
});