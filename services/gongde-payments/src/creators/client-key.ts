import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { CreatorError } from "./types.js";

function normalizedAddress(value: string): string {
  const address = value.toLowerCase();
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export function parseCreatorTrustedProxies(value = ""): string[] {
  if (!value.trim()) return [];
  const addresses = value.split(",").map(item => item.trim());
  if (addresses.length > 8 || addresses.some(address => !isIP(address))) {
    throw new CreatorError("creator_proxy_configuration_invalid", 503);
  }
  return [...new Set(addresses.map(normalizedAddress))];
}

export function creatorClientKey(request: IncomingMessage, trustedProxies: readonly string[]): string {
  const peer = normalizedAddress(request.socket.remoteAddress ?? "");
  if (!isIP(peer)) throw new CreatorError("creator_client_address_invalid", trustedProxies.length ? 403 : 503);
  // A configured proxy list is an admission gate, not just a header trust hint.
  if (trustedProxies.length && !trustedProxies.includes(peer)) {
    throw new CreatorError("creator_proxy_peer_untrusted", 403);
  }
  let address = peer;
  if (trustedProxies.includes(peer)) {
    // The configured proxy must overwrite this header, never append user input.
    const forwarded = request.headers["x-real-ip"];
    const realIpHeaderCount = request.rawHeaders?.filter((name, index) =>
      index % 2 === 0 && name.toLowerCase() === "x-real-ip").length ?? 0;
    if (realIpHeaderCount > 1 || typeof forwarded !== "string" || !isIP(forwarded)) {
      throw new CreatorError("creator_proxy_client_invalid", 503);
    }
    address = normalizedAddress(forwarded);
  }
  return createHash("sha256").update(`gongde-creator-client-v1\0${address}`).digest("hex");
}
