import type { AuthContext, Client } from "@colyseus/core";

import { env } from "../../config/env.js";

/**
 * Where the address of a room client comes from.
 * Colyseus resolves `AuthContext.ip` from `x-real-ip` / `x-forwarded-for` / `x-client-ip` before the socket address, so
 * any client could pick its own address (and dodge the per-IP limits) by sending one of those headers. Those headers
 * are therefore only honoured when the operator says the server sits behind a proxy (`TRUST_PROXY`).
 */
export type ClientAddressOptions = {
  trustProxy: boolean;
  /** Peers allowed to set the forwarded headers; empty = every peer (only safe when the proxy is the only way in). */
  trustedProxies: readonly string[];
};

let options: ClientAddressOptions = { trustProxy: env.trustProxy, trustedProxies: env.trustedProxies };

/** Overrides the proxy trust settings (tests; the default comes from `TRUST_PROXY` / `TRUSTED_PROXIES`). */
export function configureClientAddress(value: Partial<ClientAddressOptions>): void {
  options = { ...options, ...value };
}

/** Strips the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`) so the same peer always yields the same key. */
export function normalizeAddress(address: string | null | undefined): string | null {
  const value = (address ?? "").trim();
  if (!value) return null;
  return value.toLowerCase().startsWith("::ffff:") && value.includes(".") ? value.slice(7) : value;
}

/** Remote address of the websocket connection (never a header), or null when the transport doesn't expose it. */
export function socketAddressOf(client: Client): string | null {
  const ref = client?.ref as unknown as { _socket?: { remoteAddress?: string }; socket?: { remoteAddress?: string } } | undefined;
  return normalizeAddress(ref?._socket?.remoteAddress ?? ref?.socket?.remoteAddress);
}

/**
 * The address to remember in `client.auth.address` while matchmaking (static `onAuth`): the forwarded address only
 * when proxies are trusted, otherwise nothing (the socket address is read once the websocket is open).
 */
export function forwardedAddressOf(context: AuthContext | undefined): string | null {
  return options.trustProxy ? normalizeAddress(context?.ip) : null;
}

/**
 * Address of a connected client: the socket's remote address, or, with `TRUST_PROXY=true` (and the socket being one
 * of `TRUSTED_PROXIES`, when set), the forwarded address recorded at matchmaking.
 */
export function resolveClientAddress(client: Client, forwarded?: string | null): string | null {
  const socket = socketAddressOf(client);
  if (!options.trustProxy) return socket;

  const forwardedAddress = normalizeAddress(forwarded);
  if (!forwardedAddress) return socket;
  if (options.trustedProxies.length === 0) return forwardedAddress;
  const trusted = options.trustedProxies.map((address) => normalizeAddress(address));
  return socket && trusted.includes(socket) ? forwardedAddress : socket;
}

/** Address stored by the rooms' `onAuth` on `client.auth.address`. */
export function storedAddressOf(client: Client): string | null {
  return normalizeAddress(((client.auth ?? {}) as { address?: string | null }).address);
}

/** Address of a client for rate limiting / audit (null when unknown). */
export function clientAddress(client: Client): string | null {
  return resolveClientAddress(client, storedAddressOf(client));
}

/**
 * The Express `trust proxy` setting that matches the rooms: nothing is trusted unless `TRUST_PROXY=true` (`req.ip` is
 * then the socket address and `X-Forwarded-For` is ignored); with it, the listed `TRUSTED_PROXIES` (addresses or CIDR
 * ranges Express understands) may set the forwarded address, and an empty list trusts every hop (only safe when the
 * proxy is the only way in).
 */
export function expressTrustProxySetting(settings: ClientAddressOptions = options): boolean | string[] {
  if (!settings.trustProxy) return false;
  return settings.trustedProxies.length > 0 ? [...settings.trustedProxies] : true;
}
