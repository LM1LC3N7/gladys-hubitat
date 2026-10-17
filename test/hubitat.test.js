// The Maker API client: its answers and errors, then a real request against a
// local HTTP server on 127.0.0.1 (never the network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { API } from '../src/constants.js';
import { HubitatError, createClient, parseAnswer, retryAfterOf } from '../src/hubitat.js';

const kindOf = (answer) => {
  try {
    parseAnswer(answer);
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof HubitatError);
    return err.kind;
  }
};

test('the answers of the Maker API, and its errors by kind', () => {
  assert.deepEqual(parseAnswer({ status: 200, body: '[{"id":"1"}]' }), [{ id: '1' }]);
  assert.equal(parseAnswer({ status: 200, body: '' }), undefined);
  assert.equal(kindOf({ status: 200, body: '<html>login</html>' }), 'format');
  assert.equal(kindOf({ status: 401, body: '{"error":true,"type":"AccessDenied"}' }), 'auth');
  assert.equal(kindOf({ status: 403, body: '' }), 'auth');
  assert.equal(kindOf({ status: 200, body: '{"error":true,"type":"AccessDenied"}' }), 'auth');
  assert.equal(kindOf({ status: 200, body: '{"error":true,"message":"Device not found"}' }), 'api');
  assert.equal(kindOf({ status: 404, body: '' }), 'notfound');
  assert.equal(kindOf({ status: 302, headers: { location: '/login?x=1' } }), 'redirect');
  assert.equal(kindOf({ status: 500, body: '' }), 'api');
  try {
    parseAnswer({ status: 429, headers: { 'retry-after': '120' }, body: '' });
    assert.fail('429 throws');
  } catch (err) {
    assert.equal(err.kind, 'rate');
    assert.equal(err.retryAfter, 120_000);
  }
  assert.equal(retryAfterOf(undefined), undefined);
  assert.equal(
    retryAfterOf('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z')),
    60_000,
  );
  // A reason never carries a token back.
  try {
    parseAnswer({ status: 400, body: '{"message":"bad access_token=abcdef for /devices"}' });
  } catch (err) {
    assert.doesNotMatch(err.message, /abcdef/);
  }
});

test('the paths of the commands are encoded segment by segment', () => {
  assert.equal(API.command('12', 'on'), '/devices/12/on');
  assert.equal(API.command('12', 'setLevel', [50]), '/devices/12/setLevel/50');
  assert.equal(
    API.command('12', 'setColor', ['{"hue":5,"saturation":100,"level":80}']),
    '/devices/12/setColor/%7B%22hue%22%3A5%2C%22saturation%22%3A100%2C%22level%22%3A80%7D',
  );
  assert.equal(
    API.command('12', 'setThermostatMode', ['emergency heat']),
    '/devices/12/setThermostatMode/emergency%20heat',
  );
});

test('a real request: path, token in the query, timeout, no token in the errors', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/apps/api/12/devices/all')) {
      res.writeHead(200, { 'Content-Type': 'text/html' }); // Hubitat mislabels JSON
      res.end('[{"id":"5","label":"Lamp","capabilities":["Switch"],"attributes":{"switch":"on"}}]');
    } else if (req.url.startsWith('/apps/api/12/devices/5/on')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"5"}');
    } else if (req.url.startsWith('/apps/api/12/devices/6')) {
      // never answers: the timeout
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":true,"type":"AccessDenied","message":"Access denied"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ url, appId: '12', token: 'se cret' });
  t.after(() => client.close());

  const all = await client.devicesAll();
  assert.equal(all[0].label, 'Lamp');
  assert.equal(seen[0], '/apps/api/12/devices/all?access_token=se%20cret');
  await client.command('5', 'on');
  assert.equal(seen[1], '/apps/api/12/devices/5/on?access_token=se%20cret');

  await assert.rejects(client.device('6', { timeout: 200 }), (err) => {
    assert.equal(err.kind, 'timeout');
    assert.doesNotMatch(err.message, /cret/);
    return true;
  });
  await assert.rejects(client.devices(), (err) => {
    assert.equal(err.kind, 'auth');
    assert.doesNotMatch(err.message, /cret|127\.0\.0\.1/);
    return true;
  });
  // A command whose deadline is past never leaves.
  const before = seen.length;
  await assert.rejects(
    client.command('5', 'on', [], {
      guard: () => {
        throw new Error('too late');
      },
    }),
    /too late/,
  );
  assert.equal(seen.length, before);

  const wrong = createClient({ url: 'http://127.0.0.1:1', appId: '12', token: 'se cret' });
  t.after(() => wrong.close());
  await assert.rejects(wrong.devices({ timeout: 2000 }), (err) => {
    assert.equal(err.kind, 'network');
    assert.doesNotMatch(err.message, /cret/);
    return true;
  });
});
