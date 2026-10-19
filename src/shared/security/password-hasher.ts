// Password & refresh-token hashing (Argon2id + server pepper; SHA-256 + pepper for refresh tokens).

import argon2 from "argon2";
import crypto from "node:crypto";

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, passwordHash: string): Promise<boolean>;
}

export interface RefreshTokenHasher {
  hash(token: string): string;
}

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly pepper: string) {}

  hash(plain: string): Promise<string> {
    return argon2.hash(plain + this.pepper, {
      type: argon2.argon2id,
      timeCost: 3,
      memoryCost: 19456,
      parallelism: 1,
    });
  }

  async verify(plain: string, passwordHash: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, plain + this.pepper);
    } catch {
      return false;
    }
  }
}

export class Sha256RefreshTokenHasher implements RefreshTokenHasher {
  constructor(private readonly pepper: string) {}

  hash(token: string): string {
    return crypto.createHash("sha256").update(token + this.pepper, "utf8").digest("hex");
  }
}

/** URL-safe random token (refresh tokens, throwaway guest passwords). */
export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Default display/login name for guests and nameless registrations. */
export function guestName(): string {
  return `Guest-${crypto.randomInt(0, 100000).toString().padStart(5, "0")}`;
}
