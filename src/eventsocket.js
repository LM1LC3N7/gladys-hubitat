// -----------------------------------------------------------------------------
// The live events of the hub: ws://<hub>/eventsocket, a WebSocket on which the
// hub pushes every event as one JSON text message, for instance
//   {"source":"DEVICE","name":"switch","displayName":"Lamp","value":"on",
//    "unit":null,"deviceId":12,"hubId":0,"installedAppId":0,
//    "descriptionText":"Lamp was turned on","type":"digital"}
// Location events (mode, HSM) come with "source":"LOCATION" and are dropped.
// It is the socket the hub's own dashboards and many third-party tools listen
// to; it asks for no token, and carries the events of EVERY device of the hub:
// the app keeps only those of the devices authorized in the Maker API.
//
// The Maker API can also POST the events to a URL (postURL), but that needs a
// port of the integration container published on the LAN, which the Gladys
// sandbox only offers to sub-containers: the socket is used instead.
// -----------------------------------------------------------------------------

import { EVENTSOCKET_PATH, LIMITS, TIMINGS } from './constants.js';
import { deviceEventOf } from './records.js';

export class LiveError extends Error {
  /** @param {'timeout'|'closed'|'network'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'LiveError';
    this.kind = kind;
  }
}

/** The WebSocket URL of the hub at `url` (http://host[:port]). */
export const eventsocketUrl = (url) => `${url.replace(/^http/i, 'ws')}${EVENTSOCKET_PATH}`;

/**
 * Opens the event socket; resolves once it is open. Device events reach
 * `onEvent({ deviceId, name, value, unit })`; `onClose(reason)` is called
 * once when an open socket is lost (never after `close()`).
 * @param {{ url: string, WebSocket?: typeof WebSocket, timers?: object, timeout?: number, onEvent?: Function, onMessage?: Function, onClose?: Function }} options
 * @returns {Promise<{ close(): void }>}
 */
export function openEventSocket({
  url,
  WebSocket = globalThis.WebSocket,
  timers = globalThis,
  timeout = TIMINGS.liveTimeout,
  onEvent = () => {},
  onMessage = () => {},
  onClose = () => {},
}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new LiveError('network', 'no WebSocket in this Node.js'));
      return;
    }
    let ws;
    try {
      ws = new WebSocket(eventsocketUrl(url));
    } catch (err) {
      reject(new LiveError('network', err?.message ?? 'cannot open the socket'));
      return;
    }
    let ready = false;
    let done = false;

    function finish(reason, error, { notify = true } = {}) {
      if (done) {
        return;
      }
      done = true;
      timers.clearTimeout(openTimer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (!ready) {
        reject(error ?? new LiveError('closed', reason));
      } else if (notify) {
        onClose(reason);
      }
    }

    const openTimer = timers.setTimeout(() => {
      const seconds = Math.round(timeout / 1000);
      finish(
        'timeout',
        new LiveError('timeout', `the event socket did not open within ${seconds} s`),
      );
    }, timeout);

    ws.addEventListener('open', () => {
      if (done) {
        return;
      }
      ready = true;
      timers.clearTimeout(openTimer);
      resolve({
        close() {
          finish('closed', undefined, { notify: false });
        },
      });
    });
    ws.addEventListener('message', (message) => {
      const data = message?.data;
      if (!ready || done || typeof data !== 'string' || data.length > LIMITS.eventBytes) {
        return;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      // Any message (location events included) proves the socket alive (watchdog).
      onMessage();
      const event = deviceEventOf(json);
      if (event) {
        onEvent(event);
      }
    });
    ws.addEventListener('close', () => finish('connection closed'));
    ws.addEventListener('error', (event) => {
      const reason =
        event?.message ||
        event?.error?.message ||
        (ready ? 'connection lost' : 'connection failed');
      finish(reason, new LiveError('network', reason));
    });
  });
}
