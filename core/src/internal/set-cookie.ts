/**
 * `Set-Cookie` response-header parsing. Parses one header per entry; a
 * combined header string is treated as one cookie, because commas are legal
 * inside `Expires`.
 */

export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly domain?: string;
  readonly expires?: Date;
  readonly maxAge?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
}

interface MutableSetCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseOne(header: string, decodeValues: boolean): ParsedSetCookie {
  const parts = header.split(';');
  const pair = parts.shift()?.trim() ?? '';
  const separator = pair.indexOf('=');
  if (separator <= 0) throw new Error('malformed Set-Cookie header');

  const name = pair.slice(0, separator).trim();
  let value = pair.slice(separator + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (decodeValues) value = decodeValue(value);

  const cookie: MutableSetCookie = { name, value };

  for (const part of parts) {
    const attribute = part.trim();
    if (attribute === '') continue;
    const equals = attribute.indexOf('=');
    const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const raw = equals === -1 ? '' : attribute.slice(equals + 1).trim();

    switch (key) {
      case 'path':
        cookie.path = raw;
        break;
      case 'domain':
        cookie.domain = raw;
        break;
      case 'expires': {
        const date = new Date(raw);
        if (!Number.isNaN(date.getTime())) cookie.expires = date;
        break;
      }
      case 'max-age': {
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) cookie.maxAge = seconds;
        break;
      }
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = raw.toLowerCase();
        break;
      default:
        break;
    }
  }

  return cookie;
}

/** Parse one or more `Set-Cookie` header values. */
export function parseSetCookieHeaders(
  headers: readonly string[],
  options?: { decodeValues?: boolean },
): ParsedSetCookie[] {
  const decodeValues = options?.decodeValues ?? true;
  return headers.map((header) => parseOne(header, decodeValues));
}
