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
import { CONFIG, HUB_URL, fakeHub, settle } from './helpers/fakeHub.js';

const OFFERED = 16; // 17 authorized devices, the speaker has nothing to offer

async function setup(t, config = CONFIG, prepare = () => {}, { now } = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse('2026-10-17T08:00:00.000Z'),
  });
  const gladys = createFakeGladys({ config });
  const box = fakeHub();
  prepare(box);
  const app = new HubitatApp({
    gladys,
    connect: box.connect,
    live: box.openLive,
    now: now ?? (() => Date.now()),
    logger: createLogger({ level: 'silent' }),
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
  return { gladys, app, box, tick };
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

test('an energy index that drops is held; a rise above the low value is a reset', async (t) => {
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
  box.emit('104', 'energy', 0.3);
  await tick(10_000);
  assert.equal(gladys.fake.lastState(energy), 0.3);
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
