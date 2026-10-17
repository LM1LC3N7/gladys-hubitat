// -----------------------------------------------------------------------------
// The Maker API of a Hubitat Elevation hub over HTTP (local network only).
//
// Every request is a GET of http://<hub>/apps/api/<app id>/<path> with the
// access token in the query string (`?access_token=`), as the Maker API
// documents it: the URLs carry the token, so they are never logged nor put in
// an error message. The answers are JSON (Hubitat sometimes labels them
// text/html: the body is parsed whatever the content type).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { API, LIMITS, TIMINGS } from './constants.js';

export class HubitatError extends Error {
  /**
   * @param {'auth'|'notfound'|'rate'|'api'|'network'|'certificate'|'timeout'|'http'|'redirect'|'format'|'size'|'late'} kind
   * @param {string} message never a URL nor a token
   * @param {{ status?: number, retryAfter?: number }} [details] retryAfter in ms
   */
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'HubitatError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A socket error -> HubitatError (never the URL: it carries the token). */
export function networkError(err) {
  if (err instanceof HubitatError) {
    return err;
  }
  if (CERTIFICATE_CODES.has(err?.code)) {
    return new HubitatError('certificate', `certificate refused (${err.code})`);
  }
  const reason = NETWORK_REASONS[err?.code] ?? err?.code ?? 'network error';
  return new HubitatError('network', reason);
}

/**
 * One HTTP GET; resolves { status, headers, body }.
 * @param {string} url
 * @param {{ timeout: number, agent?: http.Agent, maxBytes?: number, guard?: Function }} options
 *   `guard` throws to cancel the request at the moment it would leave
 */
export function httpGet(url, { timeout, agent, maxBytes = LIMITS.responseBytes, guard }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    /** The first outcome wins: a destroyed request may still end or fail after it. */
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(
      target,
      { method: 'GET', agent, headers: { Accept: 'application/json' } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            const mb = Math.max(1, Math.round(maxBytes / 1048576));
            settle(reject, new HubitatError('size', `answer larger than ${mb} MB`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => settle(reject, networkError(err)));
      },
    );
    timer = setTimeout(() => {
      const seconds = Math.max(1, Math.round(timeout / 1000));
      settle(reject, new HubitatError('timeout', `no answer within ${seconds} s`));
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    if (!guard) {
      req.end();
      return;
    }
    // A command: the deadline is checked when the request really leaves (its
    // socket connected), not when it was queued behind another one.
    const send = () => {
      try {
        guard();
      } catch (err) {
        settle(reject, err);
        req.destroy();
        return;
      }
      req.end();
    };
    req.once('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', send);
      } else {
        send();
      }
    });
  });
}

/** The reason Hubitat gave, short, without anything that looks like a token. */
function reasonOf(json) {
  const text = json?.message ?? json?.type ?? (typeof json?.error === 'string' ? json.error : '');
  return String(text ?? '')
    .replace(/access_token=[^&\s]*/gi, 'access_token=…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Retry-After (seconds or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The JSON of an answer (undefined for an empty one), or the HubitatError it carries. */
export function parseAnswer({ status, headers = {}, body }) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  if (status >= 300 && status < 400) {
    // The path only: a redirection URL may carry the query (and the token).
    let where;
    try {
      where = new URL(headers.location, 'http://hub').pathname;
    } catch {
      where = '';
    }
    throw new HubitatError('redirect', `redirected to ${where || 'another page'}`, { status });
  }
  if (status === 401 || status === 403) {
    throw new HubitatError('auth', reasonOf(json) || `access token refused (HTTP ${status})`, {
      status,
    });
  }
  if (status === 404) {
    throw new HubitatError('notfound', reasonOf(json) || 'not found (HTTP 404)', { status });
  }
  if (status === 429) {
    throw new HubitatError('rate', 'too many requests (HTTP 429)', {
      status,
      retryAfter: retryAfterOf(headers['retry-after']),
    });
  }
  if (status >= 400) {
    const reason = reasonOf(json);
    throw new HubitatError('api', reason ? `${reason} (HTTP ${status})` : `HTTP ${status}`, {
      status,
    });
  }
  if (status < 200) {
    throw new HubitatError('http', `HTTP ${status}`, { status });
  }
  if (body && body.trim() !== '' && json === undefined) {
    throw new HubitatError('format', 'not a Maker API answer', { status });
  }
  if (json && typeof json === 'object' && !Array.isArray(json) && json.error === true) {
    // The Maker API answers some refusals with 200 and { error: true, type, message }.
    const reason = reasonOf(json) || 'refused';
    const kind = /access ?denied|token/i.test(reason) ? 'auth' : 'api';
    throw new HubitatError(kind, reason, { status });
  }
  return json;
}

/**
 * A client of one Maker API instance.
 * @param {{ url: string, appId: string, token: string, request?: typeof httpGet }} options
 */
export function createClient({ url, appId, token, request = httpGet }) {
  const Agent = (url.startsWith('https:') ? https : http).Agent;
  // The reads (a big /devices/all) never hold up a command: commands get their own agent.
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  const commandAgent = new Agent({ keepAlive: true, maxSockets: 4 });
  const base = `${url}${API.base(appId)}`;
  const send = async (path, { timeout = TIMINGS.requestTimeout, guard } = {}, via = agent) => {
    const ms = typeof timeout === 'function' ? timeout() : timeout;
    // A command must not leave once its deadline is past (guard throws), checked
    // now and again when the request really leaves.
    guard?.();
    const answer = await request(`${base}${path}?access_token=${encodeURIComponent(token)}`, {
      agent: via,
      timeout: ms,
      guard,
    });
    return parseAnswer(answer);
  };

  return {
    url,
    appId,
    /** The authorized devices, short. */
    devices(options) {
      return send(API.devices, options);
    },
    /** The authorized devices with their attributes, capabilities and commands. */
    devicesAll(options = { timeout: TIMINGS.inventoryTimeout }) {
      return send(API.devicesAll, options);
    },
    /** One device, read now (its attributes as a list). */
    device(id, options) {
      return send(API.device(id), options);
    },
    /** One command of one device, with its secondary values. */
    command(id, command, args = [], options) {
      return send(API.command(id, command, args), options, commandAgent);
    },
    close() {
      agent.destroy();
      commandAgent.destroy();
    },
  };
}
