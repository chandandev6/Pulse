import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

describe("password hashing", () => {
  it("creates an argon2id hash, not the plain password", async () => {
    const hash = await hashPassword("correct-horse");

    expect(hash).not.toBe("correct-horse");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("gives different hashes for the same password (random salt)", async () => {
    const hash1 = await hashPassword("correct-horse");
    const hash2 = await hashPassword("correct-horse");

    expect(hash1).not.toBe(hash2);
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("correct-horse");

    expect(await verifyPassword(hash, "correct-horse")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse");

    expect(await verifyPassword(hash, "wrong-horse")).toBe(false);
  });
});
