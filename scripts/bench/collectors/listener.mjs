/**
 * Listener-level driver: runs one request through a real `node:http` request
 * listener with an in-memory socket, no port.
 *
 * Production traffic does not call `app.fetch`; it goes through the Node
 * adapter, which converts the `IncomingMessage`, copies headers and writes the
 * body. Whether a response takes the adapter's direct path (one `end(bytes)`)
 * or is pumped through a web stream (`write` per chunk) is a real
 * per-request cost that an `app.fetch` measurement never sees.
 * `driveListener(listener, request)` builds a genuine `IncomingMessage` and
 * `ServerResponse` over a `Duplex` that reads the bytes written as a client
 * would, so the listener under test runs its normal path, and reports what a
 * client received (and when each body chunk reached the socket) together with
 * how the listener handed the body over. A response the
 * listener destroys with an error is reported in `error`, the way a client
 * sees a reset connection.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

/** Raised when a driven request does not finish; value-free, identified by `code`. */
export class ListenerDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ListenerDriverError';
    this.code = code;
  }
}

function toBytes(chunk, encoding) {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk);
  if (typeof chunk === 'string') {
    return new Uint8Array(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
  }
  return new Uint8Array(Buffer.from(chunk));
}

function concat(parts) {
  return new Uint8Array(Buffer.concat(parts));
}

/** The status line and header block of a response head (the bytes before CRLF CRLF). */
function parseHead(bytes) {
  const [statusLine = '', ...lines] = Buffer.from(bytes).toString('latin1').split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (match === null) return undefined;
  const rawHeaders = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    rawHeaders.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', rawHeaders };
}

const HEAD_END = Buffer.from('\r\n\r\n');

/**
 * A client-side reader of the bytes a response writes to its socket: it
 * splits off the head, then yields the body data each socket write carries,
 * with chunked transfer coding removed. `push(bytes)` returns that data
 * (possibly empty); `head` is set once the head is complete.
 */
function responseReader(method) {
  let pending = Buffer.alloc(0);
  let mode = 'head';
  // Chunked state: the bytes left in the current chunk, and whether its
  // trailing CRLF is still to come.
  let remaining = 0;
  const reader = {
    head: undefined,
    push(bytes) {
      pending = Buffer.concat([pending, bytes]);
      const data = [];
      for (;;) {
        if (mode === 'head') {
          const end = pending.indexOf(HEAD_END);
          if (end === -1) break;
          reader.head = parseHead(pending.subarray(0, end));
          pending = pending.subarray(end + HEAD_END.length);
          mode = bodyMode(reader.head, method);
        } else if (mode === 'raw') {
          if (pending.length > 0) data.push(pending);
          pending = Buffer.alloc(0);
          break;
        } else if (mode === 'size') {
          const end = pending.indexOf('\r\n');
          if (end === -1) break;
          const size = Number.parseInt(
            pending.subarray(0, end).toString('latin1').split(';')[0],
            16,
          );
          pending = pending.subarray(end + 2);
          if (!Number.isInteger(size) || size < 0) {
            mode = 'raw';
          } else if (size === 0) {
            mode = 'trailer';
          } else {
            remaining = size;
            mode = 'data';
          }
        } else if (mode === 'data') {
          if (pending.length === 0) break;
          const take = Math.min(remaining, pending.length);
          data.push(pending.subarray(0, take));
          pending = pending.subarray(take);
          remaining -= take;
          if (remaining === 0) mode = 'data-end';
        } else if (mode === 'data-end') {
          if (pending.length < 2) break;
          pending = pending.subarray(2);
          mode = 'size';
        } else if (mode === 'trailer') {
          const end = pending.indexOf('\r\n');
          if (end === -1) break;
          pending = pending.subarray(end + 2);
          if (end === 0) mode = 'done';
        } else {
          pending = Buffer.alloc(0);
          break;
        }
      }
      return new Uint8Array(Buffer.concat(data));
    },
  };
  return reader;
}

/** How the body after `head` is framed: none, chunked, or raw bytes. */
function bodyMode(head, method) {
  if (head === undefined) return 'done';
  const { status } = head;
  if (method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return 'done';
  }
  const coding = head.rawHeaders
    .filter(([name]) => name.toLowerCase() === 'transfer-encoding')
    .map(([, value]) => value.toLowerCase())
    .join(',');
  return /(?:^|,)\s*chunked\s*$/.test(coding) ? 'size' : 'raw';
}

function memorySocket(onWrite) {
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      onWrite(toBytes(chunk, encoding));
      callback();
    },
  });
  socket.remoteAddress = '127.0.0.1';
  socket.remotePort = 40000;
  socket.encrypted = false;
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  return socket;
}

/**
 * Drive `request` (a web `Request`) through `listener` (`(req, res) => void`,
 * such as a `node:http` server's `request` listener). Body chunks are what the
 * client receives: the data each socket write carries once the head is past,
 * with chunked transfer coding removed, timed as it reaches the socket, so
 * anything that holds bytes back below `res.write` (a corked response, a
 * buffering adapter) delays them. Options: `abortAfterChunks` destroys the
 * socket once that many body chunks have arrived, as a client that
 * disconnects mid-stream; `onChunk(n)` is called as the n-th body chunk
 * arrives; `timeoutMs` (default 5000) bounds the wait for the response to
 * finish.
 */
export async function driveListener(listener, request, options = {}) {
  const { abortAfterChunks, onChunk, timeoutMs = 5000 } = options;
  const url = new URL(request.url);
  const requestBody =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer());

  const started = performance.now();
  const chunks = [];
  let aborted = false;
  const reader = responseReader(request.method);
  const socket = memorySocket((bytes) => {
    const data = reader.push(bytes);
    if (data.byteLength === 0) return;
    chunks.push({ bytes: data, at: performance.now() - started });
    onChunk?.(chunks.length);
    if (abortAfterChunks !== undefined && chunks.length >= abortAfterChunks && !aborted) {
      aborted = true;
      setImmediate(() => socket.destroy());
    }
  });
  // A real server listens for socket errors (a response destroyed with an
  // error destroys its socket with it); without a listener the same event
  // would be an uncaught exception that production never sees.
  let socketError;
  socket.on('error', (error) => {
    socketError ??= error;
  });
  const incoming = new IncomingMessage(socket);
  incoming.method = request.method;
  incoming.url = `${url.pathname}${url.search}`;
  incoming.httpVersionMajor = 1;
  incoming.httpVersionMinor = 1;
  incoming.httpVersion = '1.1';
  const headers = { host: url.host };
  const rawHeaders = ['Host', url.host];
  for (const [name, value] of request.headers) {
    if (name === 'host') continue;
    headers[name] = value;
    rawHeaders.push(name, value);
  }
  if (requestBody !== undefined && !request.headers.has('content-length')) {
    headers['content-length'] = String(requestBody.byteLength);
    rawHeaders.push('content-length', String(requestBody.byteLength));
  }
  incoming.headers = headers;
  incoming.rawHeaders = rawHeaders;
  if (requestBody !== undefined && requestBody.byteLength > 0) incoming.push(requestBody);
  incoming.push(null);

  const outgoing = new ServerResponse(incoming);
  outgoing.assignSocket(socket);

  // How the listener handed over the body, which is a cost of its own: the
  // adapter's direct path is one `end(bytes)`, a pumped stream is a `write`
  // per chunk.
  let writes = 0;
  let endedWithBody = false;
  const carries = (chunk) =>
    chunk !== undefined && chunk !== null && typeof chunk !== 'function' && chunk.length !== 0;
  const write = outgoing.write;
  outgoing.write = function (chunk, encoding, callback) {
    if (carries(chunk)) writes += 1;
    return Reflect.apply(write, this, [chunk, encoding, callback]);
  };
  const end = outgoing.end;
  outgoing.end = function (chunk, encoding, callback) {
    if (carries(chunk)) endedWithBody = true;
    return Reflect.apply(end, this, [chunk, encoding, callback]);
  };

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ListenerDriverError('listener_timeout', 'the response did not finish in time'));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    outgoing.once('finish', done);
    outgoing.once('close', done);
  });
  await listener(incoming, outgoing);
  await finished;

  const head = reader.head;
  const body = concat(chunks.map((chunk) => chunk.bytes));
  const responseHeaders = new globalThis.Headers();
  for (const [name, value] of head?.rawHeaders ?? []) responseHeaders.append(name, value);
  return {
    status: head?.status ?? 0,
    statusText: head?.statusText ?? '',
    headers: responseHeaders,
    rawHeaders: head?.rawHeaders ?? [],
    body,
    text: () => new TextDecoder().decode(body),
    chunks,
    writes,
    endedWithBody,
    aborted,
    error: socketError === undefined ? undefined : String(socketError.message ?? socketError),
  };
}
