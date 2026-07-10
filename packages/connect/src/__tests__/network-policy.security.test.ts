import { afterEach, describe, expect, it } from 'vitest';
import {
  isForbiddenAddress,
  pinHttpDestination,
  setNetworkResolverForTests,
} from '../fetch/network-policy.js';

describe('network policy adversarial cases', () => {
  afterEach(() => {
    setNetworkResolverForTests();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.12.34',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ])('classifies local, private, or reserved address %s as forbidden', address => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    'http://10.0.0.1/',
    'http://127.0.0.1/',
    'http://169.254.12.34/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
  ])('blocks a direct IPv4 or IPv6 private/loopback destination without a grant: %s', async url => {
    await expect(pinHttpDestination(url, false)).rejects.toThrow(/private|reserved/i);
  });

  it.each([
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
  ])('rejects an encoded loopback URL: %s', async url => {
    await expect(pinHttpDestination(url, false)).rejects.toThrow(/private|reserved/i);
  });

  it('rejects a DNS name when any answer is private', async () => {
    setNetworkResolverForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    await expect(pinHttpDestination('https://mixed.example.test/', false)).rejects.toThrow(
      /private|reserved/i
    );
  });

  it('allows a private DNS answer only with an explicit private-network grant', async () => {
    setNetworkResolverForTests(async () => [{ address: '10.23.45.67', family: 4 }]);

    await expect(pinHttpDestination('https://private.example.test/', false)).rejects.toThrow(
      /private|reserved/i
    );
    const pinned = await pinHttpDestination('https://private.example.test/', true);
    expect(pinned.addresses).toEqual([{ address: '10.23.45.67', family: 4 }]);
    await pinned.close();
  });

  it.each([
    'http://0.0.0.0/',
    'http://192.0.2.1/',
    'http://169.254.12.34/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://[::]/',
    'http://[2001:db8::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
  ])(
    'does not widen a private-network grant to unspecified, documentation, multicast, or reserved space: %s',
    async url => {
      await expect(pinHttpDestination(url, true)).rejects.toThrow(/private|reserved|routable/i);
    }
  );

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/metadata/',
    'http://169.254.170.23/v1/credentials/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::23]/v1/credentials/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ])(
    'never permits a cloud metadata destination, even with a private-network grant: %s',
    async url => {
      setNetworkResolverForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
      await expect(pinHttpDestination(url, true)).rejects.toThrow(/metadata/i);
    }
  );

  it('does not permit an IPv4-mapped spelling of the metadata endpoint', async () => {
    await expect(
      pinHttpDestination('http://[::ffff:169.254.169.254]/latest/meta-data/', true)
    ).rejects.toThrow(/metadata/i);
  });

  it.each([
    'http://[::ffff:169.254.170.2]/v2/metadata/',
    'http://[::ffff:169.254.170.23]/v1/credentials/',
  ])('does not permit an IPv4-mapped container credential endpoint: %s', async url => {
    await expect(pinHttpDestination(url, true)).rejects.toThrow(/metadata/i);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.test/file',
    'data:text/plain,hello',
    'javascript:alert(1)',
  ])('rejects the non-HTTP URL scheme in %s', async url => {
    await expect(pinHttpDestination(url, false)).rejects.toThrow(/scheme|http/i);
  });

  it.each(['https://user@example.test/', 'https://user:password@example.test/'])(
    'rejects URL user-info credentials in %s',
    async url => {
      await expect(pinHttpDestination(url, false)).rejects.toThrow(/user-info/i);
    }
  );
});
