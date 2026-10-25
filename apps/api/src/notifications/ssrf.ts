import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { PermanentError } from "./notifier.js";

// SSRF ("server-side request forgery"): a user gives us a URL and our server calls it.
// If that URL points inside our own network (localhost, Redis, the cloud's metadata
// service at 169.254.169.254...), the user gets our server to talk to things they could
// never reach themselves. So webhooks and push may only go to public addresses.

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata (Azure, AWS, GCP)
  ["172.16.0.0", 12], // private (Docker networks live here)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // private ("unique local")
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

// "::ffff:10.0.0.1" is IPv4 10.0.0.1 written as IPv6: check the IPv4 part
const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function isPublicAddress(address: string) {
  const mapped = MAPPED_V4.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

const hostOf = (url: string) => new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();

// Right before sending. A URL with a raw IP (http://127.0.0.1/) never goes through DNS,
// so publicOnlyLookup below would never see it: those are checked here instead.
export function assertPublicIpHost(url: string) {
  const host = hostOf(url);
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new PermanentError(`${host} is a private address`);
  }
}

// Quick check when a URL is saved: catches the obvious cases right away, with a clear error.
// (A hostname can still resolve to a private address later; send time checks that.)
export function looksPrivate(url: string) {
  const host = hostOf(url);
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

// A drop-in for dns.lookup, given to the HTTP client. It runs right before connecting, so
// the address we check is the address we connect to: a hostname can't pass the check and
// then switch to 127.0.0.1 ("DNS rebinding"). Every answer must be public, not just one.
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: LookupCallback,
) {
  dnsLookup(hostname, { ...options, all: true } as { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const privateOne = addresses.find((a) => !isPublicAddress(a.address));
    if (privateOne) {
      return callback(
        new PermanentError(`${hostname} points to a private address (${privateOne.address})`),
        [],
      );
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    if (!first) return callback(new PermanentError(`${hostname} has no address`), []);
    callback(null, first.address, first.family);
  });
}
