/**
 * SHA-256 (FIPS 180-4) in plain TypeScript: no dependency, no `node:crypto`,
 * synchronous, so `@allowance/core` stays importable from a browser bundle.
 * Used to hash-chain the event log (`chain.ts`); not tuned for bulk data.
 * Checked against the NIST vectors and `node:crypto` in `sha256.test.ts`.
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();
/** Message schedule, reused across calls (the function is synchronous). */
const W = new Int32Array(64);
const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** The eight state words after hashing `data` (a string is hashed as its UTF-8 bytes). */
function digestWords(data: string | Uint8Array): Int32Array {
  const msg = typeof data === "string" ? encoder.encode(data) : data;
  // Pad: 0x80, zeros, then the bit length as a 64-bit big-endian integer.
  const len = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(len);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const bits = msg.length * 8;
  const hi = Math.floor(bits / 0x1_0000_0000);
  const lo = bits >>> 0;
  buf[len - 8] = hi >>> 24; buf[len - 7] = hi >>> 16; buf[len - 6] = hi >>> 8; buf[len - 5] = hi;
  buf[len - 4] = lo >>> 24; buf[len - 3] = lo >>> 16; buf[len - 2] = lo >>> 8; buf[len - 1] = lo;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372, h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15]!, y = W[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return Int32Array.of(h0, h1, h2, h3, h4, h5, h6, h7);
}

/** SHA-256 of `data` (a string is hashed as its UTF-8 bytes). */
export function sha256(data: string | Uint8Array): Uint8Array {
  const words = digestWords(data);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const x = words[i]!;
    out[i * 4] = x >>> 24; out[i * 4 + 1] = x >>> 16; out[i * 4 + 2] = x >>> 8; out[i * 4 + 3] = x;
  }
  return out;
}

/** SHA-256 of `data` as 64 lowercase hex digits. */
export function sha256Hex(data: string | Uint8Array): string {
  const words = digestWords(data);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    const x = words[i]!;
    hex += HEX[x >>> 24]! + HEX[(x >>> 16) & 0xff]! + HEX[(x >>> 8) & 0xff]! + HEX[x & 0xff]!;
  }
  return hex;
}
