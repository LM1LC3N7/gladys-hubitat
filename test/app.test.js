// -----------------------------------------------------------------------------
// The app through the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, and a fake hub serving the fixtures with its live events. Timers are
// mocked: the reads, the reconnections and the state flush run when the test
// ticks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HubitatApp } from '../src/app.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { LiveError } from '../src/eventsocket.js';
import { HubitatError } from '../src/hubitat.js';
import { registerHandlers } from '../src/handlers.js';
import { T } from '../src/i18n.js';
import { hsToRgbInt } from '../src/mapping.js';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, HUB_URL, fakeHub, settle } from './helpers/fakeHub.js';

const OFFERED = 16; // 17 authorized devices, the speaker has nothing to offer

/** A logger that keeps its lines (the energy guard tells its holds there). */
function linesLogger() {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

async function setup(
  t,
  config = CONFIG,
  prepare = () => {},
  {
    now,
    store = createMemoryStore(),
    devices = [],
    logger = createLogger({ level: 'silent' }),
    at = '2026-10-17T08:00:00.000Z',
  } = {},
) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse(at),
  });
  const gladys = createFakeGladys({ config, devices });
  const box = fakeHub();
  prepare(box);
  const app = new HubitatApp({
    gladys,
    connect: box.connect,
    live: box.openLive,
    now: now ?? (() => Date.now()),
    logger,
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  await gladys.connect();
  await settle();
  await tick(0); // the read that follows the opening of the socket
  return { gladys, app, box, tick, store, logger };
}

const deviceNamed = (gladys, name) => gladys.fake.discoveredDevices.find((d) => d.name === name);

async function created(gladys, name) {
  const device = deviceNamed(gladys, name);
  assert.ok(device, `${name} is discovered`);
  await gladys.fake.deviceCreated(device);
  return device;
}

const featureOf = (device, key) => {
  const feature = device.features.find((f) => f.external_id === `${device.external_id}:${key}`);
  assert.ok(feature, `${device.name} has ${key}`);
  return feature;
};

const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId);

/** The two clicks of "Accept the held index": the listing, then the acceptance. */
async function acceptTwice(gladys) {
  const first = (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  const answer = (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  return { first, answer };
}

/** A whole-home meter alone (energy-sensor/index), added to the fixtures. */
const meterDevice = () => ({
  name: 'Aeotec Home Energy Meter',
  label: 'Compteur maison',
  type: 'Aeotec HEM Gen5',
  id: '150',
  room: 'Garage',
  capabilities: ['PowerMeter', 'EnergyMeter'],
  attributes: { power: '850', energy: '9194.2' },
  commands: ['refresh', 'resetEnergy'],
});

const lastTransport = (gladys, device) =>
  gladys.fake.transports.filter((e) => e.device_external_id === device.external_id).at(-1);

test('the authorized devices become Gladys devices, live, their values sent once created', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  assert.equal(box.clients.at(-1).url, HUB_URL);
  assert.equal(box.clients.at(-1).config.appId, '12');
  assert.equal(gladys.fake.discoveredDevices.length, OFFERED);
  const lamp = deviceNamed(gladys, 'Plafonnier (Salon)');
  assert.equal(lamp.external_id, 'ext:test-integration:hubitat:101');
  assert.equal(app.liveState, 'live');
  assert.equal(box.callsOf('live').length, 1);
  assert.equal(box.callsOf('live')[0].args.url, HUB_URL);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    T.connected(OFFERED, 'live', undefined, 30).en,
  );

  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.states.length, 0, 'nothing is sent for a device not created');

  await created(gladys, 'Plafonnier (Salon)');
  const sensor = await created(gladys, 'Capteur chambre (Chambre)');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:switch`), 1);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:level`), 60);
  assert.equal(gladys.fake.lastState(`${sensor.external_id}:temperature`), 19.4);
  assert.deepEqual(lastTransport(gladys, lamp), {
    device_external_id: lamp.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  // healthStatus offline: an unreachable badge with the reason.
  const badge = lastTransport(gladys, sensor);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badge.degraded, true);
  assert.equal(badge.message.fr, T.badge.offline.fr);
});

test('live events reach Gladys at once; other devices are ignored; every press is an event', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  const remote = await created(gladys, 'Télécommande (Salon)');
  const motion = await created(gladys, 'Détecteur couloir (Couloir)');
  await tick(TIMINGS.flushInterval);

  box.emit('101', 'switch', 'off');
  box.emit('111', 'motion', 'active');
  box.emit('999', 'switch', 'on'); // a device not authorized in the Maker API
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:switch`), 0);
  assert.equal(gladys.fake.lastState(`${motion.external_id}:motion`), 1);
  assert.ok(!app.records.has('999'));

  box.emit('114', 'pushed', 2);
  box.emit('114', 'pushed', '2');
  box.emit('114', 'doubleTapped', 1);
  box.emit('114', 'held', 4);
  box.emit('114', 'released', 4); // the end of a long press
  box.emit('114', 'released', 3); // a release alone
  box.emit('114', 'pushed', 9); // no such button
  await tick(TIMINGS.flushInterval);
  assert.deepEqual(
    statesOf(gladys, `${remote.external_id}:button_2`).map((s) => s.state),
    [1, 1],
    'two presses in a row are two events',
  );
  assert.deepEqual(
    statesOf(gladys, `${remote.external_id}:button_1`).map((s) => s.state),
    [2],
  );
  assert.deepEqual(
    statesOf(gladys, `${remote.external_id}:button_4`).map((s) => s.state),
    [3, 4],
  );
  assert.deepEqual(
    statesOf(gladys, `${remote.external_id}:button_3`).map((s) => s.state),
    [20],
    'RELEASE, not the end of a long press',
  );

  // More buttons declared: the model again after the burst.
  box.emit('114', 'numberOfButtons', 6);
  await tick(TIMINGS.modelDebounce);
  const again = deviceNamed(gladys, 'Télécommande (Salon)');
  assert.ok(again.features.some((f) => f.external_id.endsWith(':button_6')));

  // A Fahrenheit event on a °C hub: converted.
  box.emit('111', 'temperature', 77, { unit: '°F' });
  await tick(10_000); // a measurement: spaced by the sensor interval
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${motion.external_id}:temperature`), 25);

  // The whole list is read again every 5 minutes.
  const reads = box.callsOf('devicesAll').length;
  await tick(TIMINGS.resync);
  assert.equal(box.callsOf('devicesAll').length, reads + 1);
});

test('commands: one Maker API command each, with the live echo as feedback', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  const bulb = await created(gladys, 'Lampe couleur (Salon)');
  const shade = await created(gladys, 'Volet salon (Salon)');
  const thermostat = await created(gladys, 'Thermostat (Entrée)');
  const valve = await created(gladys, "Vanne arrivée d'eau (Buanderie)");

  let ack = await gladys.fake.setValue(lamp, featureOf(lamp, 'level'), 25);
  assert.equal(ack.success, true, ack.error);
  ack = await gladys.fake.setValue(bulb, featureOf(bulb, 'color'), 0x00ff00);
  assert.equal(ack.success, true, ack.error);
  ack = await gladys.fake.setValue(shade, featureOf(shade, 'windowShade'), 0);
  assert.equal(ack.success, true, ack.error);
  box.emit('107', 'temperature', '20.6', { unit: '°C' }); // the scale of the hub, confirmed
  ack = await gladys.fake.setValue(thermostat, featureOf(thermostat, 'heatingSetpoint'), 21);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    box.executed.map((e) => [e.id, e.command]),
    [
      ['101', 'setLevel'],
      ['102', 'setColor'],
      ['106', 'stopPositionChange'],
      ['107', 'setHeatingSetpoint'],
    ],
  );
  assert.deepEqual(box.executed[0].args, [25]);
  assert.deepEqual(JSON.parse(box.executed[1].args[0]), { hue: 33, saturation: 100, level: 80 });
  assert.deepEqual(box.executed[3].args, [21]);
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:level`), 25);
  assert.equal(gladys.fake.lastState(`${bulb.external_id}:color`), hsToRgbInt(33, 100));

  // A valve driven as a switch has no command, and a mode the thermostat lacks is refused.
  ack = await gladys.fake.setValue(valve, featureOf(valve, 'switch'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne peut pas être pilotée/);
  box.device('107').attributes.supportedThermostatModes = '[heat, off]';
  await tick(TIMINGS.resync);
  ack = await gladys.fake.setValue(thermostat, featureOf(thermostat, 'thermostatMode'), 2);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne propose pas cette commande/);
  assert.equal(box.executed.length, 4);
});

test('locks are read-only by default; allowed, on a state read just before', async (t) => {
  const { gladys, box, app } = await setup(t);
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const lock = featureOf(door, 'lock');
  let ack = await gladys.fake.setValue(door, lock, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /lecture seule/);
  assert.equal(box.callsOf('command').length, 0);
  assert.equal(box.callsOf('device').length, 0, 'not even a read');

  await gladys.fake.configUpdated({ ...CONFIG, allow_lock_control: true });
  await settle();
  assert.equal(app.config.allowLock, true);
  // Already locked: read, nothing sent.
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(box.callsOf('device').length, 1);
  assert.equal(box.callsOf('command').length, 0);
  // Unlock: read, then the command.
  ack = await gladys.fake.setValue(door, lock, 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    box.calls.filter((c) => ['device', 'command'].includes(c.name)).map((c) => c.name),
    ['device', 'device', 'command'],
  );
  assert.deepEqual(box.executed.at(-1), { id: '108', command: 'unlock', args: [] });

  // The state in memory never decides: an unknown state on the hub refuses.
  box.device('108').attributes.lock = 'unknown';
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être lu/);
  // So does a read that fails.
  box.device('108').attributes.lock = 'unlocked';
  box.failOn.device = new HubitatError('timeout', 'no answer within 3 s');
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être lu/);
  assert.equal(box.executed.length, 1);
});

test('commands of a device run one at a time, each on its own fresh read', async (t) => {
  const { gladys, box } = await setup(t, { ...CONFIG, allow_lock_control: true });
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const lock = featureOf(door, 'lock');
  const acks = await Promise.all([
    gladys.fake.setValue(door, lock, 0),
    gladys.fake.setValue(door, lock, 1),
  ]);
  assert.ok(acks.every((a) => a.success));
  assert.deepEqual(
    box.calls.filter((c) => ['device', 'command'].includes(c.name)).map((c) => c.name),
    ['device', 'command', 'device', 'command'],
  );
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['unlock', 'lock'],
  );
});

test('garage doors: read-only by default, refused while moving, read back after', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const garage = await created(gladys, 'Garage (Garage)');
  const command = featureOf(garage, 'door_command');
  let ack = await gladys.fake.setValue(garage, command, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /portes de garage sont en lecture seule/);

  await gladys.fake.configUpdated({ ...CONFIG, allow_garage_door_control: true });
  await settle();
  box.device('109').attributes.door = 'opening';
  ack = await gladys.fake.setValue(garage, command, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /en mouvement/);
  box.device('109').attributes.door = 'closed';
  ack = await gladys.fake.setValue(garage, command, 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.executed, [{ id: '109', command: 'open', args: [] }]);
  const reads = box.callsOf('device').length;
  await tick(TIMINGS.guardReadBacks.garage[0]);
  assert.equal(box.callsOf('device').length, reads + 1, 'read back after 5 s');
  // A cover state: CLOSE is -1; STOP is refused, the opener has no stop command.
  ack = await gladys.fake.setValue(garage, command, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne propose pas cette commande/);
  ack = await gladys.fake.setValue(garage, command, -1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.executed.at(-1), { id: '109', command: 'close', args: [] });
});

test('a command not sent within 3.5 s is refused, never sent late', async (t) => {
  let skew = 0;
  const { gladys, box } = await setup(
    t,
    { ...CONFIG, allow_lock_control: true },
    (hub) => {
      hub.onDeviceRead = () => {
        skew += 4000; // the read of the state took 4 s
      };
    },
    { now: () => Date.now() + skew },
  );
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const ack = await gladys.fake.setValue(door, featureOf(door, 'lock'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop de temps/);
  assert.equal(box.executed.length, 0);
});

test('without live events: read at the configured pace, commands read back', async (t) => {
  const { gladys, app, box, tick } = await setup(
    t,
    {
      ...CONFIG,
      live_events: false,
      poll_interval: 60,
    },
    (hub) => {
      hub.echo = false;
    },
  );
  assert.equal(app.liveState, 'off');
  assert.equal(box.callsOf('live').length, 0);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Live events off: the devices are read every 60 s/,
  );
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  const reads = box.callsOf('devicesAll').length;
  await tick(60_000);
  assert.equal(box.callsOf('devicesAll').length, reads + 1);

  const ack = await gladys.fake.setValue(lamp, featureOf(lamp, 'switch'), 0);
  assert.equal(ack.success, true, ack.error);
  await tick(TIMINGS.commandEcho);
  await tick(TIMINGS.flushInterval);
  assert.equal(box.callsOf('device').length, 1, 'read back');
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:switch`), 0);
});

test('the live socket lost: reads at the configured pace, a badge, the socket again', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  box.dropLive();
  await settle();
  assert.equal(app.liveState, 'down');
  const badge = lastTransport(gladys, lamp);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(badge.degraded, true);
  const reads = box.callsOf('devicesAll').length;
  box.liveRefusal = new LiveError('network', 'connection refused');
  await tick(TIMINGS.liveRetryMin);
  assert.equal(box.callsOf('live').length, 2);
  assert.equal(app.liveState, 'down');
  await tick(30_000 - TIMINGS.liveRetryMin);
  assert.ok(box.callsOf('devicesAll').length >= reads + 1, 'read every 30 s meanwhile');
  box.liveRefusal = undefined;
  await tick(TIMINGS.liveRetryMax);
  assert.equal(app.liveState, 'live');
  assert.deepEqual(lastTransport(gladys, lamp), {
    device_external_id: lamp.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
});

test('failures: a refused token waits 5 minutes, a 429 pauses, the hub unreachable retries', async (t) => {
  const { gladys, app, box, tick } = await setup(t, { ...CONFIG, access_token: 'wrong' });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(gladys.fake.connectionStatus.message.en, T.failure({ kind: 'auth' }).en);
  const tries = box.callsOf('devicesAll').length;
  await tick(TIMINGS.authRetry - 1000);
  assert.equal(box.callsOf('devicesAll').length, tries, 'no retry loop');
  await tick(1000);
  assert.equal(box.callsOf('devicesAll').length, tries + 1);

  await gladys.fake.configUpdated(CONFIG);
  await settle();
  assert.equal(app.online, true);
  const lamp = await created(gladys, 'Plafonnier (Salon)');

  box.fail = new HubitatError('rate', 'too many requests (HTTP 429)', { retryAfter: 1000 });
  const ack = await gladys.fake.setValue(lamp, featureOf(lamp, 'switch'), 0);
  assert.equal(ack.success, false);
  await settle();
  assert.equal(app.online, false, 'a 429 on a command pauses everything');
  assert.equal(lastTransport(gladys, lamp).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  box.fail = undefined;
  const before = box.callsOf('devicesAll').length;
  await tick(TIMINGS.rateLimitMin - 1000);
  assert.equal(box.callsOf('devicesAll').length, before, 'at least one minute');
  await tick(1000);
  assert.equal(app.online, true);

  box.fail = new HubitatError('network', 'host unreachable');
  await tick(TIMINGS.resync);
  assert.equal(app.online, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable : host unreachable/);
  box.fail = undefined;
  await tick(TIMINGS.retryMin);
  assert.equal(app.online, true);
});

test('the configuration screen: errors, and the test button', async (t) => {
  const { gladys, box } = await setup(t, {
    hub_address: '192.168.1.50/apps/api/12/devices?access_token=x',
  });
  assert.equal(gladys.fake.connectionStatus.message.en, T.configError('token-in-address').en);
  assert.equal(box.callsOf('devicesAll').length, 0);
  let tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(tested.data.message.en, T.configError('token-in-address').en);

  await gladys.fake.configUpdated(CONFIG);
  await settle();
  tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(
    tested.data.message.en,
    'Connection OK, Maker API app 12 at http://192.168.1.50: 17 authorized devices, 16 devices offered in Discovery, 1 left out (nothing Gladys can show yet). Live events: OK.',
  );
  box.liveRefusal = new LiveError('timeout', 'the event socket did not open within 10 s');
  tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(
    tested.data.message.fr,
    /Pas d'événements en direct du hub \(the event socket did not open/,
  );

  await gladys.fake.configUpdated({ ...CONFIG, app_id: '13' });
  await settle();
  tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(tested.data.message.en, T.failure({ kind: 'notfound' }).en);
});

test('the Scan button reads the hub again; a deleted device is forgotten', async (t) => {
  const { gladys, app, box } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  box.devices.push({
    id: '200',
    name: 'Generic Zigbee Outlet',
    label: 'Nouvelle prise',
    type: 'Generic Zigbee Outlet',
    room: 'Bureau',
    capabilities: ['Switch', 'Outlet'],
    attributes: { switch: 'off' },
    commands: ['on', 'off'],
  });
  await gladys.fake.scanRequest();
  await settle();
  assert.ok(deviceNamed(gladys, 'Nouvelle prise (Bureau)'));
  await gladys.fake.deviceDeleted(lamp);
  assert.ok(!app.created.has(`${lamp.external_id}:switch`));
});

test('S1: a lock reporting late: [unlock, lock] -> the second waits for the first, never "already in place"', async (t) => {
  const { gladys, box, tick, app } = await setup(
    t,
    { ...CONFIG, allow_lock_control: true },
    (hub) => {
      hub.slow = { lock: 3000, door: 5000 };
    },
  );
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const lock = featureOf(door, 'lock');
  let ack = await gladys.fake.setValue(door, lock, 0);
  assert.equal(ack.success, true, ack.error);
  // The hub still says "locked": refused as busy, not taken as already in place.
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /déjà en cours/);
  // An unknown state never lifts the guard.
  box.emit('108', 'lock', 'unknown');
  await tick(1000);
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.match(ack.error, /déjà en cours/);
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['unlock'],
  );
  // The hub reports "unlocked" at 3 s: the guard is lifted.
  await tick(2000);
  assert.equal(app.guards.has('108'), false);
  ack = await gladys.fake.setValue(door, lock, 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['unlock', 'lock'],
  );
});

test('S2: a garage door: [open, close] -> close refused while opening, taken once open', async (t) => {
  const { gladys, box, tick, app } = await setup(
    t,
    { ...CONFIG, allow_garage_door_control: true },
    (hub) => {
      hub.slow = { lock: 3000, door: 5000 };
    },
  );
  const garage = await created(gladys, 'Garage (Garage)');
  const command = featureOf(garage, 'door_command');
  let ack = await gladys.fake.setValue(garage, command, 1);
  assert.equal(ack.success, true, ack.error);
  ack = await gladys.fake.setValue(garage, command, -1);
  assert.match(ack.error, /déjà en cours/);
  await tick(1000); // "opening"
  assert.equal(app.guards.get('109').sawMoving, true);
  ack = await gladys.fake.setValue(garage, command, -1);
  assert.match(ack.error, /déjà en cours/);
  await tick(4000); // "open"
  assert.equal(app.guards.has('109'), false);
  ack = await gladys.fake.setValue(garage, command, -1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['open', 'close'],
  );
});

test('a guard never confirmed expires; failed read backs mark the state unconfirmed', async (t) => {
  const { gladys, box, tick, app } = await setup(
    t,
    { ...CONFIG, allow_lock_control: true },
    (hub) => {
      hub.slow = { lock: 60_000, door: 60_000 }; // never in time
    },
  );
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const lock = featureOf(door, 'lock');
  assert.equal((await gladys.fake.setValue(door, lock, 0)).success, true);
  box.failOn.device = new HubitatError('timeout', 'no answer within 15 s');
  await tick(TIMINGS.guardReadBacks.lock[0]);
  let badge = lastTransport(gladys, door);
  assert.equal(badge.degraded, true);
  assert.equal(badge.message.fr, T.badge.unconfirmed.fr);
  delete box.failOn.device;
  await tick(TIMINGS.guardReadBacks.lock[1] - TIMINGS.guardReadBacks.lock[0]); // read back OK
  await tick(TIMINGS.guard.lock - TIMINGS.guardReadBacks.lock[1]);
  assert.equal(app.guards.has('108'), false, 'expired');
  assert.equal(lastTransport(gladys, door).message.fr, T.badge.unconfirmed.fr);
  // The next full read shows a state: the badge is clear again.
  await tick(TIMINGS.resync);
  badge = lastTransport(gladys, door);
  assert.equal(badge.degraded, undefined);
});

test('a read keeps the values of the events that came during it, and the units seen', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  const motion = await created(gladys, 'Détecteur couloir (Couloir)');
  box.emit('111', 'temperature', 77, { unit: '°F' });
  const client = box.clients.at(-1);
  const devicesAll = client.devicesAll;
  client.devicesAll = async (options) => {
    const answer = await devicesAll(options); // the snapshot says "on"
    box.emit('101', 'switch', 'off'); // an event while the answer travels
    return answer;
  };
  box.device('101').attributes.switch = 'on';
  await tick(TIMINGS.resync);
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:switch`), 0, 'the event wins');
  await tick(10_000);
  assert.equal(
    gladys.fake.lastState(`${motion.external_id}:temperature`),
    25,
    'the °F of the event is kept: 77 is not read as °C',
  );
});

test('S4b: without live events, a hub and an option in °C: the setpoint is sent', async (t) => {
  const { gladys, box } = await setup(t, { ...CONFIG, live_events: false });
  const thermostat = await created(gladys, 'Thermostat (Entrée)');
  const ack = await gladys.fake.setValue(thermostat, featureOf(thermostat, 'heatingSetpoint'), 21);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.executed.at(-1), { id: '107', command: 'setHeatingSetpoint', args: [21] });
});

test('S4c: before the first event, the option and a plausible setpoint decide', async (t) => {
  const { gladys, box } = await setup(t);
  const thermostat = await created(gladys, 'Thermostat (Entrée)');
  const setpoint = featureOf(thermostat, 'heatingSetpoint');
  let ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.equal(ack.success, true, ack.error);
  // A hub in °F configured in °C: its setpoint (68) is out of the °C band.
  box.device('107').attributes.heatingSetpoint = 68;
  await gladys.fake.scanRequest();
  ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas confirmée/);
  // An unknown current setpoint is refused too.
  delete box.device('107').attributes.heatingSetpoint;
  await gladys.fake.scanRequest();
  ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.equal(ack.success, false);
  assert.equal(box.executed.length, 1);
});

test('temperature scale: the hub contradicting the option refuses; bands decide', async (t) => {
  const { gladys, box, app } = await setup(t);
  const thermostat = await created(gladys, 'Thermostat (Entrée)');
  const setpoint = featureOf(thermostat, 'heatingSetpoint');
  let ack;
  // The hub says °F, the option °C: told in the status and the logs, refused.
  box.emit('111', 'temperature', 70, { unit: '°F' });
  await settle();
  assert.equal(app.scaleMismatch, true);
  assert.match(gladys.fake.connectionStatus.message.en, /reports temperatures in °F/);
  ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.match(ack.error, /pas confirmée/);
  // °C confirmed, but a current setpoint of 68 is no °C value.
  box.emit('111', 'temperature', 21, { unit: '°C' });
  box.emit('107', 'heatingSetpoint', 68);
  ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.match(ack.error, /pas confirmée/);
  box.emit('107', 'heatingSetpoint', 19);
  ack = await gladys.fake.setValue(thermostat, setpoint, 21);
  assert.equal(ack.success, true, ack.error);
  assert.equal(app.scaleMismatch, false);
});

test('watchdog: a change no event told, or a silent socket, opens the socket again', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  assert.equal(box.callsOf('live').length, 1);
  const lamp = await created(gladys, 'Plafonnier (Salon)');
  box.silently('111', 'motion', 'active');
  await tick(TIMINGS.resync);
  // Reopened at once, never "down", no degraded badge.
  assert.equal(box.callsOf('live').length, 2, 'the missed event is seen');
  assert.equal(app.liveState, 'live');
  assert.ok(!gladys.fake.transports.some((e) => e.degraded));
  assert.deepEqual(lastTransport(gladys, lamp), {
    device_external_id: lamp.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  // No message at all for more than 30 minutes.
  for (let i = 0; i < 7; i += 1) {
    await tick(TIMINGS.resync);
  }
  assert.ok(box.callsOf('live').length >= 3);
  assert.equal(app.liveState, 'live');
  // A reopening that fails: down, the badge says so.
  box.liveRefusal = new LiveError('network', 'connection refused');
  box.silently('111', 'motion', 'inactive');
  await tick(TIMINGS.resync);
  assert.equal(app.liveState, 'down');
  assert.equal(lastTransport(gladys, lamp).degraded, true);
});

test('S9b: an index read at 0 twice, then back: no false consumption', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 0);
  await tick(10_000);
  box.emit('104', 'energy', 0); // the same low value read again: still held
  await tick(10_000);
  box.emit('104', 'energy', 312.5);
  await tick(10_000);
  assert.deepEqual(
    statesOf(gladys, energy).map((s) => s.state),
    [312.4, 312.5],
    'the index never went through 0',
  );
});

test('an energy index that drops is held, never taken by a later rise; only the action takes it', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(energy), 312.4);
  box.emit('104', 'energy', 3.1); // a glitch
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.4);
  box.emit('104', 'energy', 312.9);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.9);
  box.emit('104', 'energy', 0.2); // reset by the user
  box.emit('104', 'energy', 0.3); // a rise above the low value: still held
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.9);
  assert.equal(lastTransport(gladys, plug).degraded, undefined, 'a drop shown once it lasted');
  await tick(TIMINGS.dropShownAfter);
  assert.equal(lastTransport(gladys, plug).degraded, true);
  assert.equal(
    lastTransport(gladys, plug).message.fr,
    T.badge.held({ direction: 'down', from: 312.9, to: 0.3 }).fr,
  );
  const { first, answer } = await acceptTwice(gladys);
  assert.match(first.fr, /312,9 → 0,3 kWh \(0 kWh\)/);
  assert.match(answer.en, /312\.9 → 0\.3 kWh \(0 kWh\)/);
  assert.match(answer.fr, /0 kWh seront comptés/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 0.3);
  box.emit('104', 'energy', 0.4);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 0.4);
  assert.equal(lastTransport(gladys, plug).degraded, undefined);
});

test('a jump of an energy index is held: last value sent again, badge, log; only the action takes it', async (t) => {
  const logger = linesLogger();
  const { gladys, app, box, tick } = await setup(t, CONFIG, () => {}, { logger });
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 5312.4); // +5000 kWh in a second: a glitch of the driver
  await tick(10_000);
  // Repeated for hours: never confirmed by repetition nor by time.
  for (let i = 1; i <= 12; i += 1) {
    box.emit('104', 'energy', Number((5312.4 + i * 0.01).toFixed(2)));
    await tick(TIMINGS.resync);
  }
  assert.deepEqual(
    [...new Set(statesOf(gladys, energy).map((s) => s.state))],
    [312.4],
    'only the last accepted value, never the jump nor 0',
  );
  const badge = lastTransport(gladys, plug);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(badge.degraded, true);
  assert.match(badge.message.fr, /saut de 312,4 à 5312,52 kWh/);
  assert.match(badge.message.en, /would count 5000\.12 kWh at once/);
  assert.ok(badge.message.fr.length <= 200);
  assert.equal(logger.lines.filter((l) => /energy index jump .* held back/.test(l)).length, 1);
  // Neither a save of the form nor a reconnection to Gladys accepts it.
  await gladys.fake.configUpdated(CONFIG);
  await settle();
  await app.resume(CONFIG);
  await tick(TIMINGS.resync);
  assert.ok(!statesOf(gladys, energy).some((s) => s.state > 312.4));
  // The first click only lists the hold and its kWh.
  const listing = (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  assert.match(listing.fr, /Rien n'est encore accepté/);
  assert.match(listing.fr, /312,4 → 5312,52 kWh \(5000,12 kWh\)/);
  await tick(10_000);
  assert.ok(!statesOf(gladys, energy).some((s) => s.state > 312.4), 'nothing taken by one click');
  const answer = (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  assert.match(answer.fr, /312,4 → 5312,52 kWh \(5000,12 kWh\)/);
  assert.match(answer.fr, /5000,12 kWh seront comptés d'un coup/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 5312.52);
  assert.equal(lastTransport(gladys, plug).degraded, undefined);
  assert.ok(logger.lines.some((l) => /accepted by the user/.test(l)));
  assert.equal(
    (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message.en,
    T.accept.nothing.en,
  );
  // An old acceptance never covers a new jump.
  box.emit('104', 'energy', 9000);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 5312.52);
});

test('an accepted jump never takes another value: held again', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 1312.4);
  await tick(10_000);
  const { answer } = await acceptTwice(gladys);
  assert.match(answer.en, /1000 kWh will be counted/);
  // Taken at once from the value read: 1312.4. A later 9000 is not what was accepted.
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 1312.4);
  box.emit('104', 'energy', 9000);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 1312.4);
  assert.equal(lastTransport(gladys, plug).degraded, true);
});

test('a held index survives a restart (/data), dated at its loading; Gladys gives the reference', async (t) => {
  const store = createMemoryStore();
  const first = await setup(t, CONFIG, () => {}, { store });
  const plug = await created(first.gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await first.tick(TIMINGS.flushInterval);
  first.box.emit('104', 'energy', 5312.4);
  await first.tick(10_000);
  first.app.stop();
  await settle();
  assert.equal(store.data[energy].held.direction, 'up');
  assert.equal(store.data[energy].held.from, 312.4);
  assert.deepEqual(Object.keys(store.data), [energy], 'only the created energy features');
  t.mock.timers.reset();

  // A new container, 5 days later; Gladys holds 312.4 (last_value).
  const device = structuredClone(plug);
  const feature = device.features.find((f) => f.external_id === energy);
  feature.last_value = 312.4;
  feature.last_value_changed = '2026-10-17T08:00:00.000Z';
  const second = await setup(t, CONFIG, (box) => box.silently('104', 'energy', 5312.5), {
    store,
    devices: [device],
    at: '2026-10-22T08:00:00.000Z',
  });
  await second.tick(TIMINGS.flushInterval);
  const guard = second.app.indexGuards.get(energy);
  assert.equal(guard.held.direction, 'up');
  assert.ok(guard.held.at >= Date.parse('2026-10-22T08:00:00.000Z'), 'dated at the loading');
  assert.ok(!statesOf(second.gladys, energy).some((s) => s.state > 312.4));
  assert.equal(lastTransport(second.gladys, device).degraded, true);
  await acceptTwice(second.gladys);
  await second.tick(10_000);
  assert.equal(second.gladys.fake.lastState(energy), 5312.5);
});

test('a device created again starts a new guard: nothing held from the deleted one', async (t) => {
  const store = createMemoryStore();
  const { gladys, app, box, tick } = await setup(t, CONFIG, () => {}, { store });
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 3.1);
  await tick(10_000);
  assert.equal(app.indexGuards.get(energy).held.direction, 'down');
  await gladys.fake.deviceDeleted(plug);
  // An update keeps the guard (only a creation resets it).
  await gladys.fake.deviceCreated(plug);
  await tick(TIMINGS.flushInterval);
  assert.equal(app.indexGuards.get(energy).held, undefined);
  assert.equal(store.data[energy]?.held ?? null, null);
  assert.equal(gladys.fake.lastState(energy), 3.1, 'the first value of the new device');
  box.emit('104', 'energy', 0);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 3.1, 'never 0');
  box.emit('104', 'energy', 3000);
  await tick(10_000);
  await gladys.fake.deviceUpdated(plug);
  await tick(TIMINGS.flushInterval);
  assert.equal(app.indexGuards.get(energy).held.direction, 'up', 'an update accepts nothing');
  assert.equal(gladys.fake.lastState(energy), 3.1);
});

test('an index read at 0 when the device is created is never sent', async (t) => {
  const { gladys, box, tick } = await setup(t, CONFIG, (hub) => hub.silently('104', 'energy', 0));
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  assert.equal(statesOf(gladys, energy).length, 0);
  box.emit('104', 'energy', 312.6);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.6);
});

test('a second click never takes a drop lower than the one listed', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 12);
  await tick(TIMINGS.dropShownAfter + 1000);
  assert.equal(gladys.fake.lastState(energy), 312.4, 'a drop held');
  const action = async () => (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  let message = await action();
  assert.match(message.en, /^Nothing accepted yet\./);
  box.emit('104', 'energy', 5);
  await tick(10_000);
  message = await action();
  assert.match(message.en, /^Nothing accepted yet\./, 'a first click again');
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.4, 'never 5 kWh without a click');
  message = await action();
  assert.match(message.en, /^Accepted/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 5, 'the value listed, accepted');
});

test('M1: the first click lists the holds; only a second click on the same holds within 2 min takes them', async (t) => {
  const { gladys, app, box, tick } = await setup(t, CONFIG, (hub) =>
    hub.devices.push(meterDevice()),
  );
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const meter = await created(gladys, 'Compteur maison (Garage)');
  const plugEnergy = `${plug.external_id}:energy`;
  const meterEnergy = `${meter.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 5312.4); // a glitch of the plug
  await tick(10_000);
  const action = async () => (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  let message = await action();
  assert.match(message.en, /^Nothing accepted yet\. Held back \(1 index\)/);
  assert.match(message.en, /5000 kWh/);
  // Meanwhile a second hold appears: the next click is a first click again.
  box.emit('150', 'energy', 3.2);
  await tick(TIMINGS.dropShownAfter + 1000);
  message = await action();
  assert.match(message.en, /^Nothing accepted yet\. Held back \(2 indexes\)/);
  assert.equal(app.indexGuards.get(plugEnergy).accepted, undefined);
  // Too late (over 2 minutes): a first click again.
  await tick(TIMINGS.acceptConfirm + 1000);
  message = await action();
  assert.match(message.en, /^Nothing accepted yet/);
  // The same holds, within 2 minutes: taken, both.
  await tick(30_000);
  message = await action();
  assert.match(message.en, /^Accepted \(2 indexes\)/);
  assert.match(message.en, /5000 kWh will be counted/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(plugEnergy), 5312.4);
  assert.equal(gladys.fake.lastState(meterEnergy), 3.2);
  assert.equal((await action()).en, T.accept.nothing.en);
});

test('M1: a hold that changes between the two clicks is listed again, never taken', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 5312.4);
  await tick(10_000);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD, {});
  // Back to normal, then another jump: another hold (another threshold).
  box.emit('104', 'energy', 312.5);
  box.emit('104', 'energy', 7312.5);
  await tick(10_000);
  const message = (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  assert.match(message.en, /^Nothing accepted yet/);
  assert.match(message.en, /7000 kWh/);
  assert.equal(app.indexGuards.get(energy).accepted, undefined);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 312.5);
});

test('R5: a jump that grows between the two clicks is listed again, never counted beyond the listing', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  box.emit('104', 'energy', 5312.4);
  await tick(10_000);
  const action = async () => (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  assert.match((await action()).en, /^Nothing accepted yet.*5000 kWh/);
  // A bigger glitch, above the threshold (same fingerprint): beyond what was listed.
  box.emit('104', 'energy', 9312.4);
  await tick(10_000);
  const second = await action();
  assert.match(second.en, /^Nothing accepted yet.*9000 kWh/);
  await tick(10_000);
  assert.ok(!statesOf(gladys, energy).some((s) => s.state > 312.4), 'nothing taken');
  // Within the listing (+ the margin of 10 kW since): taken.
  box.emit('104', 'energy', 9312.41);
  await tick(10_000);
  assert.match((await action()).en, /^Accepted .*9000\.01 kWh will be counted/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 9312.41);
  // Below the value listed: listed again too.
  box.emit('104', 'energy', 20_000);
  await tick(10_000);
  await action();
  box.emit('104', 'energy', 19_000);
  await tick(10_000);
  assert.match((await action()).en, /^Nothing accepted yet/);
});

test('R4: a reset meter that reports every 10 s: the second click takes the drop', async (t) => {
  const { gladys, box, tick } = await setup(t, CONFIG, (hub) => hub.devices.push(meterDevice()));
  const meter = await created(gladys, 'Compteur maison (Garage)');
  const energy = `${meter.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  let v = 0.01;
  box.emit('150', 'energy', v); // resetEnergy, then it counts again
  for (let i = 0; i < 12; i += 1) {
    v = Number((v + 0.01).toFixed(2));
    box.emit('150', 'energy', v);
    await tick(10_000);
  }
  const action = async () => (await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message;
  assert.match((await action()).en, /^Nothing accepted yet/);
  v = Number((v + 0.01).toFixed(2));
  box.emit('150', 'energy', v); // one reading between the two clicks
  await tick(10_000);
  assert.match((await action()).en, /^Accepted \(1 index\).*0 kWh will be counted/);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), v);
});

test('R6: a lasting drop whose low value rises: one warning and one /data write for the hold', async (t) => {
  const store = createMemoryStore();
  let saves = 0;
  const save = store.save.bind(store);
  store.save = async (data) => {
    saves += 1;
    return save(data);
  };
  const logger = linesLogger();
  const { gladys, box, tick } = await setup(t, CONFIG, (hub) => hub.devices.push(meterDevice()), {
    store,
    logger,
  });
  await created(gladys, 'Compteur maison (Garage)');
  await tick(TIMINGS.flushInterval);
  const before = saves;
  let v = 0.01;
  for (let i = 0; i < 60; i += 1) {
    box.emit('150', 'energy', v);
    v = Number((v + 0.01).toFixed(2));
    await tick(10_000);
  }
  const warns = logger.lines.filter((l) => l.startsWith('warn') && /held back/.test(l)).length;
  assert.equal(warns, 1, 'one warning for the hold');
  assert.ok(saves - before <= 2, `${saves - before} writes of /data for 60 readings`);
});

test('F1: the plausible power depends on the type: 10 kW for a plug, 25 kW for a meter', async (t) => {
  const { gladys, app, box, tick } = await setup(t, CONFIG, (hub) =>
    hub.devices.push(meterDevice()),
  );
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const meter = await created(gladys, 'Compteur maison (Garage)');
  const plugEnergy = `${plug.external_id}:energy`;
  const meterEnergy = `${meter.external_id}:energy`;
  assert.equal(featureOf(plug, 'energy').category, 'switch');
  assert.equal(featureOf(meter, 'energy').category, 'energy-sensor');
  await tick(TIMINGS.flushInterval);
  assert.equal(app.indexGuards.get(plugEnergy).maxKw, 10);
  assert.equal(app.indexGuards.get(meterEnergy).maxKw, 25);
  // +15 kWh in an hour: too much for a plug, plausible for a home.
  await tick(60 * 60_000);
  box.emit('104', 'energy', 327.4);
  box.emit('150', 'energy', 9209.2);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(plugEnergy), 312.4);
  assert.equal(app.indexGuards.get(plugEnergy).held.direction, 'up');
  assert.equal(gladys.fake.lastState(meterEnergy), 9209.2);
});

test('F2: a drop is shown, logged and written only once it lasted a minute (a jittery driver tells nothing)', async (t) => {
  const store = createMemoryStore();
  let saves = 0;
  const save = store.save.bind(store);
  store.save = async (data) => {
    saves += 1;
    return save(data);
  };
  const logger = linesLogger();
  const { gladys, box, tick } = await setup(t, CONFIG, () => {}, { store, logger });
  const plug = await created(gladys, 'Prise lave-linge (Buanderie)');
  const energy = `${plug.external_id}:energy`;
  await tick(TIMINGS.flushInterval);
  const badges = gladys.fake.transports.length;
  const before = saves;
  // 61 values, ending on 312.41: no drop lasts.
  for (let i = 0; i <= 60; i += 1) {
    box.emit('104', 'energy', i % 2 === 0 ? 312.41 : 312.4);
    await tick(1000);
  }
  await tick(TIMINGS.dropShownAfter);
  assert.equal(gladys.fake.transports.length, badges, 'no badge for a jitter');
  assert.ok(!logger.lines.some((l) => /held back/.test(l)), 'no warning for a jitter');
  assert.ok(saves - before <= 1, `${saves - before} writes of /data (the reference only)`);
  assert.equal(store.data[energy]?.held ?? null, null);
  // A real drop, still there a minute later: shown, logged, written.
  box.emit('104', 'energy', 3.1);
  await tick(30_000);
  assert.equal(lastTransport(gladys, plug).degraded, undefined);
  assert.equal(store.data[energy]?.held ?? null, null);
  assert.match((await gladys.fake.action(ACTIONS.ACCEPT_HELD, {})).data.message.en, /^No energy/);
  await tick(TIMINGS.dropShownAfter);
  assert.equal(lastTransport(gladys, plug).degraded, true);
  assert.equal(store.data[energy].held.direction, 'down');
  assert.equal(logger.lines.filter((l) => /energy index drop .* held back/.test(l)).length, 1);
  // A deleted device leaves /data at once.
  await gladys.fake.deviceDeleted(plug);
  assert.ok(!(energy in store.data));
});

test('a 429 pause covers the scan, the test button and a reconnection to Gladys', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  box.fail = new HubitatError('rate', 'too many requests (HTTP 429)', { retryAfter: 120_000 });
  await tick(TIMINGS.resync);
  assert.equal(app.online, false);
  box.fail = undefined;
  const calls = box.calls.length;
  await gladys.fake.scanRequest();
  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(tested.data.message.en, T.failure({ kind: 'rate' }).en);
  await app.resume(CONFIG); // Gladys reconnected: the pause is kept
  await settle();
  assert.equal(box.calls.length, calls, 'no request to the hub during the pause');
  await tick(120_000);
  assert.equal(app.online, true);
});

test('R2: a moving garage door can be stopped while it is guarded', async (t) => {
  const { gladys, box, tick, app } = await setup(
    t,
    { ...CONFIG, allow_garage_door_control: true },
    (hub) => {
      hub.device('109').commands.push('stop');
      hub.slow = { lock: 3000, door: 5000 };
    },
  );
  const garage = await created(gladys, 'Garage (Garage)');
  const command = featureOf(garage, 'door_command');
  assert.equal((await gladys.fake.setValue(garage, command, 1)).success, true);
  await tick(1000); // "opening"
  assert.ok(app.guards.has('109'));
  const ack = await gladys.fake.setValue(garage, command, 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['open', 'stop'],
  );
});

test('R3: a command refused as too late at the socket never left: no guard', async (t) => {
  let skew = 0;
  const { gladys, box, app } = await setup(
    t,
    { ...CONFIG, allow_lock_control: true },
    (hub) => {
      hub.onCommand = () => {
        skew += 4000; // the request waited 4 s before leaving
      };
    },
    { now: () => Date.now() + skew },
  );
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const lock = featureOf(door, 'lock');
  let ack = await gladys.fake.setValue(door, lock, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop de temps/);
  assert.equal(box.executed.length, 0);
  assert.equal(app.guards.has('108'), false);
  box.onCommand = undefined;
  ack = await gladys.fake.setValue(door, lock, 0);
  assert.equal(ack.success, true, ack.error, 'not refused as busy');
  assert.deepEqual(
    box.executed.map((e) => e.command),
    ['unlock'],
  );
});
