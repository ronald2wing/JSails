/**
 * {@link sha256Hex}: a synchronous SHA-256 (FIPS 180-4) over bytes.
 *
 * Approval digests are computed and checked while `run` validates its
 * options, so a forged approval is refused synchronously, before a response
 * starts. Web Crypto only digests asynchronously and `node:crypto` is not
 * browser-safe, so the digest is computed here. It binds a decision to a
 * call; it guards no secret, so constant-time execution is not a concern.
 */

const INITIAL: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const ROUND: Uint32Array = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function word(words: Uint32Array, index: number): number {
  return words[index] ?? 0;
}

/** The SHA-256 digest of `data` as 64 lowercase hex characters. */
export function sha256Hex(data: Uint8Array): string {
  const length = data.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const state = new Uint32Array(INITIAL);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const early = word(schedule, index - 15);
      const late = word(schedule, index - 2);
      const sigma0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3);
      const sigma1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10);
      schedule[index] = word(schedule, index - 16) + sigma0 + word(schedule, index - 7) + sigma1;
    }
    let a = word(state, 0);
    let b = word(state, 1);
    let c = word(state, 2);
    let d = word(state, 3);
    let e = word(state, 4);
    let f = word(state, 5);
    let g = word(state, 6);
    let h = word(state, 7);
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + word(ROUND, index) + word(schedule, index)) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = word(state, 0) + a;
    state[1] = word(state, 1) + b;
    state[2] = word(state, 2) + c;
    state[3] = word(state, 3) + d;
    state[4] = word(state, 4) + e;
    state[5] = word(state, 5) + f;
    state[6] = word(state, 6) + g;
    state[7] = word(state, 7) + h;
  }
  let hex = '';
  for (const value of state) hex += value.toString(16).padStart(8, '0');
  return hex;
}
