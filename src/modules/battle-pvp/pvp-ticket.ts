// Room creation ticket: only the server (the friendly battle service) creates `battle_pvp` rooms. A client calling
// `create("battle_pvp", { matchId })` has no ticket; a ticket is the HMAC of the match id with a server secret, valid
// on every process that shares the secret.

import crypto from "node:crypto";

const DOMAIN = "battle_pvp:";

export function signMatchTicket(secret: string, matchId: string): string {
  return crypto.createHmac("sha256", secret).update(DOMAIN + matchId).digest("base64url");
}

export function verifyMatchTicket(secret: string, matchId: unknown, ticket: unknown): boolean {
  if (typeof matchId !== "string" || typeof ticket !== "string" || !matchId || !ticket) return false;
  const expected = Buffer.from(signMatchTicket(secret, matchId));
  const given = Buffer.from(ticket);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
