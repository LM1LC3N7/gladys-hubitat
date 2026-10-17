import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, parseHubAddress } from '../src/config.js';

test('the hub address: an IP, a URL, a Maker API URL, and what is refused', () => {
  assert.deepEqual(parseHubAddress('192.168.1.50'), { url: 'http://192.168.1.50' });
  assert.deepEqual(parseHubAddress(' http://192.168.1.50:8080/ '), {
    url: 'http://192.168.1.50:8080',
  });
  assert.deepEqual(parseHubAddress('https://hub.lan'), { url: 'https://hub.lan' });
  assert.deepEqual(parseHubAddress('http://192.168.1.50/apps/api/12/devices'), {
    url: 'http://192.168.1.50',
    appId: '12',
  });
  assert.deepEqual(parseHubAddress(''), { error: 'empty' });
  assert.deepEqual(parseHubAddress('ftp://hub'), { error: 'invalid' });
  assert.deepEqual(parseHubAddress('http://a:b@hub'), { error: 'credentials' });
  assert.deepEqual(parseHubAddress('http://192.168.1.50/apps/api/12/devices?access_token=secret'), {
    error: 'token-in-address',
  });
  assert.deepEqual(parseHubAddress('https://cloud.hubitat.com/api/abc/apps/12'), {
    error: 'cloud',
  });
  assert.deepEqual(parseHubAddress('hubitat.local'), { error: 'local-name' });
});

test('the configuration: defaults, errors, bounds, safety options off', () => {
  const empty = normalizeConfig();
  assert.equal(empty.error, 'empty');
  assert.equal(empty.allowLock, false);
  assert.equal(empty.allowGarage, false);
  assert.equal(empty.live, true);
  assert.equal(empty.temperatureScale, 'C');
  assert.equal(empty.language, 'fr');
  assert.equal(DEFAULTS.allow_lock_control, false);
  assert.equal(DEFAULTS.allow_garage_door_control, false);

  assert.equal(normalizeConfig({ hub_address: '10.0.0.2' }).error, 'no-app');
  assert.equal(normalizeConfig({ hub_address: '10.0.0.2', app_id: 'abc' }).error, 'bad-app');
  assert.equal(normalizeConfig({ hub_address: '10.0.0.2', app_id: '7' }).error, 'no-token');
  const full = normalizeConfig({
    hub_address: 'http://10.0.0.2/apps/api/7/devices',
    access_token: ' tok ',
    temperature_scale: 'f',
    language: 'en',
    live_events: 'false',
    poll_interval: 5,
    sensor_interval: 999,
    allow_lock_control: true,
    allow_garage_door_control: 'true',
  });
  assert.deepEqual(full, {
    url: 'http://10.0.0.2',
    appId: '7',
    token: 'tok',
    error: undefined,
    temperatureScale: 'F',
    language: 'en',
    live: false,
    pollInterval: 10,
    sensorInterval: 300,
    allowLock: true,
    allowGarage: true,
  });
  // The app number typed wins over the one of a pasted URL.
  assert.equal(
    normalizeConfig({ hub_address: 'http://h/apps/api/7/', app_id: '9', access_token: 't' }).appId,
    '9',
  );
});
