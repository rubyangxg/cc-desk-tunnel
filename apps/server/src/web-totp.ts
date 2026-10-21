import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() {
  let value = 0,
    bits = 0,
    result = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  return result;
}
function decode(secret: string) {
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
export function totp(secret: string, step: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function totpStep(secret: string, code: string, now: number, last: number) {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = Math.floor(now / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (
      step >= 0 &&
      step > last &&
      timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))
    )
      return step;
  }
  return undefined;
}
