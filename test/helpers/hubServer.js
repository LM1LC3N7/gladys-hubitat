// A simulated Hubitat hub on 127.0.0.1 (never the network): the Maker API over
// HTTP (devices/all, devices/<id>, commands, the access_token of the query)
// and the event socket, a minimal WebSocket server pushing the events as
// JSON like the hub (/eventsocket). The frame code is written apart from the
// client on purpose: the client is not checked against itself.

import { createHash } from 'node:crypto';
import http from 'node:http';
import { APP_ID, TOKEN, effect, fixture } from './fakeHub.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One server text frame (not masked). */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

export async function hubServer({ token = TOKEN, appId = APP_ID } = {}) {
  const sim = {
    devices: fixture('devices-all.json'),
    /** every HTTP request: { path, token } */
    requests: [],
    /** the open event sockets */
    sockets: [],
    upgrades: 0,
  };
  sim.device = (id) => sim.devices.find((d) => d.id === String(id));

  const json = (res, status, body) => {
    // Hubitat labels its JSON text/html.
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  /** An event of the hub, to every event socket (like the hub, for every device). */
  sim.emit = (id, name, value, { unit = null, source = 'DEVICE' } = {}) => {
    const device = sim.device(id);
    if (device && !['pushed', 'held', 'doubleTapped', 'released'].includes(name)) {
      device.attributes[name] = value;
    }
    const text = JSON.stringify({
      source,
      name,
      displayName: device?.label ?? null,
      value: String(value),
      type: 'digital',
      unit,
      deviceId: Number(id),
      hubId: 0,
      installedAppId: 0,
      descriptionText: `${device?.label} ${name} is ${value}`,
    });
    for (const socket of sim.sockets.filter((s) => !s.destroyed)) {
      socket.write(frame(text));
    }
  };

  sim.drop = () => {
    for (const socket of sim.sockets) {
      socket.destroy();
    }
  };

  const details = (device) => ({
    ...device,
    attributes: Object.entries(device.attributes).map(([name, currentValue]) => ({
      name,
      currentValue,
      dataType: typeof currentValue === 'number' ? 'NUMBER' : 'STRING',
    })),
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://hub');
    sim.requests.push({ path: url.pathname, token: url.searchParams.get('access_token') });
    const base = `/apps/api/${appId}`;
    if (!url.pathname.startsWith(`${base}/`)) {
      json(res, 404, { error: true, type: 'NotFound' });
      return;
    }
    if (url.searchParams.get('access_token') !== token) {
      json(res, 401, { error: true, type: 'AccessDenied', message: 'Access denied' });
      return;
    }
    const parts = url.pathname
      .slice(base.length + 1)
      .split('/')
      .map(decodeURIComponent);
    if (parts[0] !== 'devices') {
      json(res, 404, { error: true, type: 'NotFound' });
      return;
    }
    if (parts.length === 2 && parts[1] === 'all') {
      json(res, 200, sim.devices);
      return;
    }
    const device = sim.device(parts[1]);
    if (!device) {
      json(res, 404, { error: true, type: 'NotFound' });
      return;
    }
    if (parts.length === 2) {
      json(res, 200, details(device));
      return;
    }
    const changes = effect(device.attributes, parts[2], parts.slice(3));
    if (!changes) {
      json(res, 404, { error: true, type: 'NotFound' });
      return;
    }
    json(res, 200, details(device));
    // The hub reports the change a little later, on the event socket.
    setTimeout(() => {
      for (const [name, value] of Object.entries(changes)) {
        sim.emit(device.id, name, value);
      }
    }, 20);
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/eventsocket') {
      socket.destroy();
      return;
    }
    sim.upgrades += 1;
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      // A close frame from the client: close.
      if ((chunk[0] & 0x0f) === 8) {
        socket.end();
      }
    });
    sim.sockets.push(socket);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  sim.url = `http://127.0.0.1:${server.address().port}`;
  sim.close = () =>
    new Promise((resolve) => {
      sim.drop();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return sim;
}

/** Waits for a condition (real time), up to `ms`. */
export async function waitFor(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
