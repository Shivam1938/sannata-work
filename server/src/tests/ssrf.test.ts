import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config to control ALLOW_PRIVATE_TARGETS
vi.mock('../config/index.js', () => ({
  config: {
    allowPrivateTargets: false,
    encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    logLevel: 'silent',
    nodeEnv: 'test',
    port: 3001,
  },
  validateConfig: vi.fn(),
}));

// Mock dns to avoid real network calls
vi.mock('dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'dns/promises';
import { checkSsrf, SsrfError } from '../services/ssrf-guard.js';
import { config } from '../config/index.js';

const mockDnsLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

describe('SSRF Guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: allowPrivateTargets = false
    (config as { allowPrivateTargets: boolean }).allowPrivateTargets = false;
  });

  describe('protocol checks', () => {
    it('allows http URLs', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(checkSsrf('http://example.com')).resolves.toBeDefined();
    });

    it('allows https URLs', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(checkSsrf('https://example.com')).resolves.toBeDefined();
    });

    it('blocks ftp:// protocol', async () => {
      await expect(checkSsrf('ftp://example.com')).rejects.toThrow(SsrfError);
    });

    it('blocks file:// protocol', async () => {
      await expect(checkSsrf('file:///etc/passwd')).rejects.toThrow(SsrfError);
    });
  });

  describe('private IPv4 ranges', () => {
    const privateIPs = [
      ['127.0.0.1', 'loopback'],
      ['127.0.0.2', 'loopback range'],
      ['10.0.0.1', 'RFC 1918 class A'],
      ['10.255.255.255', 'RFC 1918 class A end'],
      ['172.16.0.1', 'RFC 1918 class B start'],
      ['172.31.255.255', 'RFC 1918 class B end'],
      ['192.168.0.1', 'RFC 1918 class C'],
      ['192.168.255.255', 'RFC 1918 class C end'],
      ['169.254.0.1', 'link-local'],
      ['169.254.169.254', 'AWS metadata'],
      ['0.0.0.0', 'unspecified'],
    ];

    for (const [ip, label] of privateIPs) {
      it(`blocks ${label} (${ip})`, async () => {
        mockDnsLookup.mockResolvedValue([{ address: ip, family: 4 }]);
        await expect(checkSsrf(`http://target.com`)).rejects.toThrow(SsrfError);
      });
    }
  });

  describe('private IPv6 ranges', () => {
    it('blocks IPv6 loopback ::1', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
      await expect(checkSsrf('http://target.com')).rejects.toThrow(SsrfError);
    });

    it('blocks IPv6 link-local fe80::', async () => {
      mockDnsLookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);
      await expect(checkSsrf('http://target.com')).rejects.toThrow(SsrfError);
    });

    it('blocks IPv6 unique local fc00::', async () => {
      mockDnsLookup.mockResolvedValue([{ address: 'fc00::1', family: 6 }]);
      await expect(checkSsrf('http://target.com')).rejects.toThrow(SsrfError);
    });
  });

  describe('ALLOW_PRIVATE_TARGETS=true', () => {
    it('allows private IPs when ALLOW_PRIVATE_TARGETS=true', async () => {
      (config as { allowPrivateTargets: boolean }).allowPrivateTargets = true;
      // Should return [] without DNS check
      const result = await checkSsrf('http://localhost:3000');
      expect(result).toEqual([]);
    });
  });

  describe('DNS failures', () => {
    it('throws SsrfError on DNS failure', async () => {
      mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(checkSsrf('http://nonexistent.invalid')).rejects.toThrow(SsrfError);
    });

    it('throws SsrfError on empty DNS result', async () => {
      mockDnsLookup.mockResolvedValue([]);
      await expect(checkSsrf('http://example.com')).rejects.toThrow(SsrfError);
    });
  });

  describe('invalid URLs', () => {
    it('throws SsrfError for malformed URLs', async () => {
      await expect(checkSsrf('not-a-url')).rejects.toThrow(SsrfError);
    });
  });

  describe('public IPs', () => {
    it('allows a real public IP', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(checkSsrf('https://example.com')).resolves.not.toThrow();
    });

    it('allows multiple public IPs', async () => {
      mockDnsLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
      await expect(checkSsrf('https://example.com')).resolves.not.toThrow();
    });
  });
});
