import { hash, verify } from "@node-rs/argon2";

// OWASP recommended settings for argon2id
const options = {
  memoryCost: 19456, // 19 MB
  timeCost: 2, // iterations
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
