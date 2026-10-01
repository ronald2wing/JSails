/**
 * Credentials key rings: the one or two keys (current, then previous) that may
 * open an environment's sealed document.
 *
 * A key is 32 random bytes in base64url. Its id is the first 8 bytes of
 * HKDF-SHA256 over the key with the info `jsails-credentials-keyid`, written as
 * hex, and a sealed document names the id of the key that sealed it, so the
 * loader picks the right key whatever order the ring lists them in. That is
 * what makes rotation safe: add the new key, re-seal the document under it in
 * one atomic write, and drop the old key once every server runs the new
 * document; at no point does a server hold a document none of its keys opens.
 *
 * The key file holds one key per line; `JSAILS_CREDENTIALS_KEY` holds them
 * separated by a comma (or whitespace). The key bytes live in a private field,
 * so logging, inspecting or serializing a ring shows only its ids.
 */

import { hkdfSync, randomBytes } from 'node:crypto';

import { CredentialsErrors } from './errors.js';

const KEY_BYTES = 32;
const KEY_ID_BYTES = 8;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_INFO = 'jsails-credentials-keyid';
const ENCRYPTION_INFO = 'jsails-credentials-v2-encryption';

/** One key: its id and the AES-256 key derived from it. */
interface RingKey {
  readonly text: string;
  readonly id: string;
  readonly encryptionKey: Buffer;
}

/**
 * One or two credentials keys, the first being the current one.
 *
 * @internal
 */
export class KeyRing {
  readonly #keys: readonly RingKey[];

  private constructor(keys: readonly RingKey[]) {
    this.#keys = keys;
    Object.freeze(this);
  }

  /**
   * Parse a ring from a key file's or the variable's text. Throws
   * `credentials.invalid_key` for a malformed key and
   * `credentials.invalid_key_ring` for none, more than two, or a repeated key.
   */
  static parse(text: string): KeyRing {
    const tokens = text.split(/[\s,]+/).filter((token) => token !== '');
    if (tokens.length === 0 || tokens.length > 2 || new Set(tokens).size !== tokens.length) {
      throw new CredentialsErrors.Error('invalid_key_ring');
    }
    return new KeyRing(tokens.map(ringKey));
  }

  /** A ring holding one freshly generated key. */
  static generate(): KeyRing {
    return new KeyRing([ringKey(randomBytes(KEY_BYTES).toString('base64url'))]);
  }

  /** The key ids, current first. */
  get ids(): readonly string[] {
    return this.#keys.map((key) => key.id);
  }

  /** The id of the current key, the one a new document is sealed with. */
  get currentId(): string {
    return (this.#keys[0] as RingKey).id;
  }

  /** How many keys the ring holds (one or two). */
  get size(): number {
    return this.#keys.length;
  }

  /** Whether the ring holds the key `id`. */
  has(id: string): boolean {
    return this.#keys.some((key) => key.id === id);
  }

  /** The AES-256 key derived from the ring's key `id`, or `undefined`. */
  encryptionKey(id: string): Buffer | undefined {
    return this.#keys.find((key) => key.id === id)?.encryptionKey;
  }

  /** This ring with a freshly generated key in front: the first step of a rotation. */
  withNewKey(): KeyRing {
    if (this.#keys.length !== 1) throw new CredentialsErrors.Error('invalid_key_ring');
    const fresh = ringKey(randomBytes(KEY_BYTES).toString('base64url'));
    return new KeyRing([fresh, this.#keys[0] as RingKey]);
  }

  /** This ring reduced to the key `id`: the last step of a rotation. */
  only(id: string): KeyRing {
    const key = this.#keys.find((candidate) => candidate.id === id);
    if (key === undefined) throw new CredentialsErrors.Error('invalid_key_ring');
    return new KeyRing([key]);
  }

  /**
   * The ring as key-file text, one key per line. The key material leaves the
   * ring only here and in {@link toVariable}; write it to a 0600 file or a
   * secret channel, never to output, an argv or a log.
   */
  toKeyFile(): string {
    return `${this.#keys.map((key) => key.text).join('\n')}\n`;
  }

  /** The ring as a `JSAILS_CREDENTIALS_KEY` value: the keys comma-separated, current first. */
  toVariable(): string {
    return this.#keys.map((key) => key.text).join(',');
  }

  /** What `JSON.stringify` and logging see: the ids only. */
  toJSON(): { readonly ids: readonly string[] } {
    return { ids: this.ids };
  }
}

function ringKey(text: string): RingKey {
  if (!KEY_TEXT.test(text)) throw new CredentialsErrors.Error('invalid_key');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== KEY_BYTES || bytes.toString('base64url') !== text) {
    throw new CredentialsErrors.Error('invalid_key');
  }
  return Object.freeze({
    text,
    id: Buffer.from(hkdfSync('sha256', bytes, Buffer.alloc(0), KEY_ID_INFO, KEY_ID_BYTES)).toString(
      'hex',
    ),
    encryptionKey: Buffer.from(hkdfSync('sha256', bytes, Buffer.alloc(0), ENCRYPTION_INFO, 32)),
  });
}
