import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvgPath } from '../src/lib/qr.ts';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totp,
  totpStep,
  verifyTotp,
} from '../src/lib/totp.ts';

const ascii = (s: string) => Buffer.from(s, 'ascii');

describe('base32 (RFC 4648 §10 test vectors)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  it.each(vectors)('encodes %j', (plain, encoded) => {
    expect(base32Encode(ascii(plain))).toBe(encoded.replace(/=+$/, ''));
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('decodes leniently and rejects other characters', () => {
    expect(base32Decode('mzxw 6ytb-oi').toString('ascii')).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow(/Invalid base32/);
  });

  it('round-trips random secrets', () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Encode(base32Decode(secret))).toBe(secret);
    }
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it('matches the reference values', () => {
    const key = ascii('12345678901234567890');
    expect(expected.map((_, counter) => hotp(key, counter))).toEqual(expected);
  });
});

describe('TOTP (RFC 6238 Appendix B)', () => {
  const seeds = {
    sha1: ascii('12345678901234567890'),
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const table: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(table)('T=%i', (seconds, sha1, sha256, sha512) => {
    const at = seconds * 1000;
    expect(totp(seeds.sha1, at, { digits: 8 })).toBe(sha1);
    expect(totp(seeds.sha256, at, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(totp(seeds.sha512, at, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
    // The 6-digit code is the same value modulo 10^6.
    expect(totp(seeds.sha1, at)).toBe(sha1.slice(2));
  });

  it('uses 30-second steps', () => {
    expect(totpStep(59_000)).toBe(1);
    expect(totpStep(60_000)).toBe(2);
    expect(totpStep(1111111109_000)).toBe(37037036);
  });
});

describe('verifyTotp', () => {
  const key = base32Decode(generateTotpSecret());
  const now = 1_760_000_000_000;
  const step = totpStep(now);
  const codeAt = (s: number) => hotp(key, s);

  it('accepts the current step and one step either side', () => {
    expect(verifyTotp(key, codeAt(step), { now })).toEqual({ ok: true, step });
    expect(verifyTotp(key, codeAt(step - 1), { now })).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(key, codeAt(step + 1), { now })).toEqual({ ok: true, step: step + 1 });
  });

  it('rejects codes outside the window', () => {
    for (const s of [step - 2, step + 2]) {
      const code = codeAt(s);
      // Skip the (rare) case where a far code happens to equal a code inside the window.
      if ([step - 1, step, step + 1].some((x) => codeAt(x) === code)) continue;
      expect(verifyTotp(key, code, { now })).toEqual({ ok: false, reused: false });
    }
    expect(verifyTotp(key, codeAt(step + 2), { now, window: 2 }).ok).toBe(true);
  });

  it('refuses a code from a step already used (replay protection)', () => {
    expect(verifyTotp(key, codeAt(step), { now, lastUsedStep: step })).toEqual({ ok: false, reused: true });
    expect(verifyTotp(key, codeAt(step - 1), { now, lastUsedStep: step })).toEqual({ ok: false, reused: true });
    expect(verifyTotp(key, codeAt(step + 1), { now, lastUsedStep: step })).toEqual({ ok: true, step: step + 1 });
  });

  it('rejects malformed input and tolerates spaces', () => {
    expect(verifyTotp(key, '12345', { now }).ok).toBe(false);
    expect(verifyTotp(key, '1234567', { now }).ok).toBe(false);
    expect(verifyTotp(key, 'abcdef', { now }).ok).toBe(false);
    const code = codeAt(step);
    expect(verifyTotp(key, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok).toBe(true);
  });
});

describe('otpauth URI', () => {
  it('describes the account for authenticator apps', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'ApexOs', account: 'owner@homeserver' });
    expect(uri).toBe('otpauth://totp/ApexOs:owner%40homeserver?secret=JBSWY3DPEHPK3PXP&issuer=ApexOs&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('generates distinct, readable codes and normalizes input', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    expect(normalizeRecoveryCode(` ${codes[0]!.toUpperCase()} `)).toBe(codes[0]!.replace('-', ''));
    expect(normalizeRecoveryCode('abc')).toBeNull();
    expect(normalizeRecoveryCode('abcde-fgh1l')).toBeNull();
  });
});

describe('QR encoder', () => {
  const fingerprint = (text: string) => {
    const qr = encodeQr(text);
    const bits = qr.modules.map((row) => row.map((b) => (b ? '1' : '0')).join('')).join('\n');
    return { version: qr.version, mask: qr.mask, size: qr.size, sha256: createHash('sha256').update(bits).digest('hex') };
  };

  it('produces the verified matrices for known input', () => {
    // Pinned after decoding the output with an independent QR reader.
    expect(fingerprint('ApexOs')).toEqual({ version: 1, mask: 2, size: 21, sha256: 'c5f1dffa9ee46ef4dcf57c079579cf4eb956d176c0b7024aaa122d53d389d374' });
    expect(fingerprint('otpauth://totp/ApexOs:owner%40homeserver?secret=JBSWY3DPEHPK3PXP&issuer=ApexOs&algorithm=SHA1&digits=6&period=30')).toEqual({
      version: 7,
      mask: 4,
      size: 45,
      sha256: 'bcfeb7f931ff62b9284d4f6d2498056327f1e68921a2ddf10516cd1289a73494',
    });
  });

  it('draws finder patterns and fits a full otpauth URI', () => {
    const uri = otpauthUri({ secret: generateTotpSecret(), issuer: 'ApexOs', account: `${'a'.repeat(32)}@${'b'.repeat(15)}` });
    const qr = encodeQr(uri);
    expect(qr.version).toBeLessThanOrEqual(10);
    const corner = (x0: number, y0: number) => [0, 1, 2, 3, 4, 5, 6].map((d) => qr.modules[y0]![x0 + d]).join(',');
    const finderTop = 'true,true,true,true,true,true,true';
    expect(corner(0, 0)).toBe(finderTop);
    expect(corner(qr.size - 7, 0)).toBe(finderTop);
    expect(corner(0, qr.size - 7)).toBe(finderTop);
    expect(qrSvgPath(qr)).toMatch(/^M0 0h7v1h-7z/);
    expect(() => encodeQr('x'.repeat(300))).toThrow(/too long/);
  });
});
