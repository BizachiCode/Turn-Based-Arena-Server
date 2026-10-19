// Development convenience: on the very first `npm start`, create `.env` from `.env.example` with
// freshly generated secrets. Never runs in production (production must be configured explicitly).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GENERATED_SECRETS = ["JWT_ACCESS_SECRET", "PASSWORD_PEPPER", "REFRESH_PEPPER", "CONFIG_API_KEY"];

export function ensureDevEnvFile(cwd = process.cwd()): string | null {
  if ((process.env.NODE_ENV || "development") === "production") return null;

  const envPath = path.join(cwd, ".env");
  const examplePath = path.join(cwd, ".env.example");
  if (fs.existsSync(envPath) || !fs.existsSync(examplePath)) return null;

  const content = fs.readFileSync(examplePath, "utf8").split(/\r?\n/).map((line) => {
    const key = line.split("=")[0]?.trim();
    return GENERATED_SECRETS.includes(key) ? `${key}=${crypto.randomBytes(32).toString("base64url")}` : line;
  }).join("\n");

  fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  console.log(`[setup] Created ${envPath} from .env.example with random secrets (admin key: CONFIG_API_KEY).`);
  console.log("[setup] Edit MYSQL_* in .env if your MySQL/MariaDB credentials differ from the defaults.");
  return envPath;
}

ensureDevEnvFile();
