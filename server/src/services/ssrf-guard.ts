import dns from 'dns/promises';
import { config } from '../config/index.js';

// Private/reserved IP ranges (IPv4)
const PRIVATE_RANGES_V4 = [
  /^127\./,           // Loopback
  /^10\./,            // RFC 1918 class A
  /^172\.(1[6-9]|2\d|3[01])\./,  // RFC 1918 class B (172.16-31)
  /^192\.168\./,      // RFC 1918 class C
  /^169\.254\./,      // Link-local / AWS metadata
  /^0\./,             // Unspecified
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT (RFC 6598)
  /^198\.51\.100\./,  // TEST-NET-2
  /^203\.0\.113\./,   // TEST-NET-3
  /^224\./,           // Multicast
  /^240\./,           // Reserved
  /^255\.255\.255\.255$/, // Broadcast
];

// Private IPv6 ranges
const PRIVATE_RANGES_V6 = [
  /^::1$/,            // Loopback
  /^fc[0-9a-f][0-9a-f]:/i,  // Unique local
  /^fd[0-9a-f][0-9a-f]:/i,  // Unique local
  /^fe80:/i,          // Link-local
  /^::$/,             // Unspecified
  /^ff[0-9a-f][0-9a-f]:/i,  // Multicast
  /^64:ff9b:/i,       // NAT64
];

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_RANGES_V4.some((r) => r.test(ip));
}

function isPrivateIPv6(ip: string): boolean {
  // Normalise IPv6 for simple checks
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return PRIVATE_RANGES_V6.some((r) => r.test(normalized));
}

/**
 * Validate a URL for SSRF safety.
 * Returns the resolved IPs so the caller can pin the connection.
 * Throws SsrfError if the URL is not safe.
 */
export async function checkSsrf(rawUrl: string): Promise<string[]> {
  if (config.allowPrivateTargets) return [];

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid URL');
  }

  const { protocol, hostname } = parsed;

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new SsrfError(`Protocol "${protocol}" is not allowed. Only http and https are permitted.`);
  }

  if (!hostname) {
    throw new SsrfError('URL has no hostname');
  }

  // Resolve the hostname
  let addresses: string[] = [];
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    addresses = resolved.map((r) => r.address);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'DNS resolution failed';
    throw new SsrfError(`DNS resolution failed for "${hostname}": ${message}`);
  }

  if (addresses.length === 0) {
    throw new SsrfError(`DNS returned no addresses for "${hostname}"`);
  }

  for (const addr of addresses) {
    // Distinguish IPv4 from IPv6 by the presence of ':'
    const isIPv6 = addr.includes(':');
    if (isIPv6) {
      if (isPrivateIPv6(addr)) {
        throw new SsrfError(`Target resolves to a private/reserved IPv6 address: ${addr}`);
      }
    } else {
      if (isPrivateIPv4(addr)) {
        throw new SsrfError(`Target resolves to a private/reserved IPv4 address: ${addr}`);
      }
    }
  }

  return addresses;
}
