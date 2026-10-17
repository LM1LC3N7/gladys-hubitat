// The pure part: hub answers -> records -> Gladys features, readers, writers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/devices.js';
import {
  BUTTON_STATUS,
  COVER_STATE,
  MIREDS,
  SENSITIVE_CAPABILITIES,
  fromCelsius,
  hsToRgbInt,
  kelvinToMireds,
  mapDevice,
  miredsToKelvin,
  modeList,
  rgbIntToHs,
  scaleOf,
  toCelsius,
} from '../src/mapping.js';
import { deviceEventOf, recordOf, recordsOf, withAttribute } from '../src/records.js';
import { fixture } from './helpers/fakeHub.js';

const records = recordsOf(fixture('devices-all.json'));
const mapped = (id, options) => mapDevice(records.get(id), options);
const keys = (m) => m.features.map((f) => f.key);
const feature = (m, key) => m.features.find((f) => f.key === key);
const read = (m, key, record) => m.readers.find((r) => r.key === key).read(record);

test('the two answer shapes give the same kind of record', () => {
  // GET /devices/<id> (the hacs-hubitat fixture): attributes as a list, capability objects mixed in.
  const details = fixture('device-details.json');
  const contact = recordOf(details['6']);
  assert.equal(contact.id, '6');
  assert.equal(contact.label, 'Office Door');
  assert.equal(contact.room, 'Office');
  assert.deepEqual(
    [...contact.capabilities],
    ['Battery', 'ContactSensor', 'Configuration', 'Sensor', 'TamperAlert'],
  );
  assert.equal(contact.attributes.get('contact').value, 'open');
  assert.deepEqual(contact.attributes.get('contact').values, ['closed', 'open']);
  const m = mapDevice(contact);
  assert.deepEqual(keys(m), ['battery', 'contact', 'tamper']);
  assert.deepEqual(read(m, 'contact', contact), { state: 0 }, 'open is 0 in Gladys');
  // A duplicated attribute ("switch" twice): the first is kept.
  const outlet = recordOf(details['176']);
  assert.equal(outlet.attributes.get('switch').value, 'off');
  assert.deepEqual(keys(mapDevice(outlet)), ['switch', 'power']);
  // /devices/all: attributes as an object, commands as objects or strings.
  const bulb = records.get('102');
  assert.ok(bulb.commands.has('setColor'));
  assert.equal(bulb.attributes.get('hue').value, 66.67);
});

test('lights: dimmer, colour and white bulbs', () => {
  const dimmer = mapped('101');
  assert.deepEqual(keys(dimmer), ['switch', 'level']);
  assert.equal(feature(dimmer, 'switch').category, 'light');
  assert.equal(feature(dimmer, 'switch').name, 'Plafonnier');
  assert.equal(feature(dimmer, 'level').name, 'Plafonnier – Luminosité');
  assert.deepEqual(read(dimmer, 'level', records.get('101')), { state: 60 });
  assert.deepEqual(dimmer.writers.level.write(30.4), [{ command: 'setLevel', args: [30] }]);
  assert.deepEqual(dimmer.writers.switch.write(0), [{ command: 'off', args: [] }]);

  const bulb = mapped('102', { language: 'en' });
  assert.deepEqual(keys(bulb), ['switch', 'level', 'color', 'colorTemperature']);
  assert.equal(feature(bulb, 'color').name, 'Lampe couleur – Colour');
  assert.deepEqual(read(bulb, 'color', records.get('102')), { state: 0x0000ff });
  assert.equal(read(bulb, 'colorTemperature', records.get('102')), null, 'RGB mode: no CT');
  const [setColor] = bulb.writers.color.write(0xff0000, records.get('102'));
  assert.equal(setColor.command, 'setColor');
  assert.deepEqual(JSON.parse(setColor.args[0]), { hue: 0, saturation: 100, level: 80 });

  const ct = mapped('103');
  assert.deepEqual(keys(ct), ['switch', 'level', 'colorTemperature']);
  assert.deepEqual(read(ct, 'colorTemperature', records.get('103')), { state: 250 });
  assert.deepEqual(ct.writers.colorTemperature.write(370), [
    { command: 'setColorTemperature', args: [2703] },
  ]);
});

test('plugs, switches and a valve driven as a switch', () => {
  const plug = mapped('104');
  assert.deepEqual(keys(plug), ['switch', 'voltage', 'amperage', 'power', 'energy']);
  assert.equal(feature(plug, 'switch').category, 'switch', 'an Outlet is not a light');
  assert.deepEqual([feature(plug, 'power').type, feature(plug, 'power').unit], ['power', 'watt']);
  assert.deepEqual(
    [feature(plug, 'energy').category, feature(plug, 'energy').type, feature(plug, 'energy').unit],
    ['switch', 'energy', 'kilowatt-hour'],
  );
  assert.deepEqual(read(plug, 'power', records.get('104')), { state: 1520.5 });
  assert.ok(plug.throttled.has('power') && !plug.throttled.has('switch'));

  const valve = mapped('116');
  assert.deepEqual(keys(valve), ['switch']);
  assert.equal(feature(valve, 'switch').read_only, true, 'water is not switched from Gladys');
  assert.equal(valve.writers.switch, undefined);
  assert.deepEqual(valve.skipped, ['Valve']);
});

test('shades: state, position, stop', () => {
  const shade = mapped('106');
  assert.deepEqual(keys(shade), ['windowShade', 'position', 'battery']);
  assert.equal(feature(shade, 'windowShade').category, 'shutter');
  assert.deepEqual(read(shade, 'windowShade', records.get('106')), { state: COVER_STATE.STOP });
  assert.deepEqual(read(shade, 'position', records.get('106')), { state: 35 });
  assert.deepEqual(shade.writers.windowShade.write(1), [{ command: 'open', args: [] }]);
  assert.deepEqual(shade.writers.windowShade.write(-1), [{ command: 'close', args: [] }]);
  assert.deepEqual(shade.writers.windowShade.write(0), [
    { command: 'stopPositionChange', args: [] },
  ]);
  assert.deepEqual(shade.writers.position.write(70), [{ command: 'setPosition', args: [70] }]);
  const closing = withAttribute(records.get('106'), 'windowShade', 'closing');
  assert.deepEqual(read(shade, 'windowShade', closing), { state: COVER_STATE.CLOSE });
});

test('thermostats: setpoints in °C, modes, activity, Fahrenheit hubs', () => {
  const thermostat = mapped('107');
  assert.deepEqual(keys(thermostat), [
    'heatingSetpoint',
    'coolingSetpoint',
    'thermostatMode',
    'thermostatOperatingState',
    'temperature',
    'humidity',
  ]);
  const r = records.get('107');
  assert.deepEqual(read(thermostat, 'heatingSetpoint', r), { state: 19.5 });
  assert.equal(feature(thermostat, 'heatingSetpoint').unit, 'celsius');
  assert.deepEqual(read(thermostat, 'thermostatMode', r), { state: 1 });
  assert.deepEqual(read(thermostat, 'thermostatOperatingState', r), { state: 1 });
  assert.deepEqual(thermostat.writers.heatingSetpoint.write(20.3, r), [
    { command: 'setHeatingSetpoint', args: [20.5] },
  ]);
  assert.deepEqual(thermostat.writers.thermostatMode.write(3, r), [
    { command: 'setThermostatMode', args: ['auto'] },
  ]);
  const heatOnly = withAttribute(r, 'supportedThermostatModes', '[heat, off]');
  assert.throws(() => thermostat.writers.thermostatMode.write(2, heatOnly), {
    refusal: 'unsupported',
  });

  // A hub in °F: read in °C, sent back in whole °F.
  const f = mapped('107', { scale: 'F' });
  const hot = withAttribute(r, 'temperature', 68);
  assert.deepEqual(read(f, 'temperature', hot), { state: 20 });
  assert.deepEqual(f.writers.heatingSetpoint.write(21, hot), [
    { command: 'setHeatingSetpoint', args: [70] },
  ]);
  // The unit of an event wins over the configured scale.
  const tagged = withAttribute(r, 'temperature', 77, '°F');
  assert.deepEqual(read(thermostat, 'temperature', tagged), { state: 25 });
});

test('locks and garage doors are commands marked for the safety checks', () => {
  const lock = mapped('108');
  assert.deepEqual(keys(lock), ['lock', 'battery']);
  assert.equal(feature(lock, 'lock').category, 'lock');
  assert.equal(lock.writers.lock.safety, 'lock');
  assert.deepEqual(read(lock, 'lock', records.get('108')), { state: 1 });
  assert.equal(read(lock, 'lock', withAttribute(records.get('108'), 'lock', 'unknown')), null);

  const garage = mapped('109');
  assert.deepEqual(keys(garage), ['door', 'door_command', 'contact']);
  assert.equal(garage.writers.door_command.safety, 'garage');
  assert.equal(garage.writers.door, undefined);
  assert.deepEqual(read(garage, 'door', records.get('109')), { state: 1 }, 'closed is 1');
  // The command is a cover state, never a switch ("turn everything off").
  const command = feature(garage, 'door_command');
  assert.deepEqual(
    [command.category, command.type, command.min, command.max],
    ['shutter', 'state', -1, 1],
  );
  assert.deepEqual(read(garage, 'door_command', records.get('109')), { state: COVER_STATE.CLOSE });
  const opening = withAttribute(records.get('109'), 'door', 'opening');
  assert.deepEqual(read(garage, 'door_command', opening), { state: COVER_STATE.OPEN });
  assert.deepEqual(garage.writers.door_command.write(1), [{ command: 'open', args: [] }]);
  assert.deepEqual(garage.writers.door_command.write(-1), [{ command: 'close', args: [] }]);
  assert.throws(() => garage.writers.door_command.write(0), { refusal: 'unsupported' });
  const withStop = { ...records.get('109'), commands: new Set(['open', 'close', 'stop']) };
  assert.deepEqual(mapDevice(withStop).writers.door_command.write(0), [
    { command: 'stop', args: [] },
  ]);
});

test('the switch of a lock, door, valve, siren or keypad is read-only, one by one', () => {
  for (const capability of SENSITIVE_CAPABILITIES) {
    const record = {
      ...records.get('105'),
      capabilities: new Set(['Switch', capability]),
    };
    const m = mapDevice(record);
    assert.equal(feature(m, 'switch').read_only, true, capability);
    assert.equal(m.writers.switch, undefined, capability);
  }
  assert.deepEqual(SENSITIVE_CAPABILITIES, [
    'Lock',
    'GarageDoorControl',
    'DoorControl',
    'Valve',
    'Alarm',
    'SecurityKeypad',
  ]);
  // A plain switch stays writable.
  assert.equal(feature(mapped('105'), 'switch').read_only, false);
});

test('UV index as an integer; an energy meter in Wh converted to kWh', () => {
  const uv = mapDevice({
    ...records.get('112'),
    capabilities: new Set(['UltravioletIndex']),
    attributes: new Map([['ultravioletIndex', { value: '3.6' }]]),
  });
  assert.deepEqual(
    [feature(uv, 'ultravioletIndex').category, feature(uv, 'ultravioletIndex').type],
    ['uv-sensor', 'integer'],
  );
  const uvRecord = { attributes: new Map([['ultravioletIndex', { value: '3.6' }]]) };
  assert.deepEqual(uv.readers[0].read(uvRecord), { state: 4 });
  const plug = mapped('104');
  const energy = plug.readers.find((r) => r.key === 'energy');
  assert.equal(energy.meter, true);
  assert.deepEqual(energy.read(withAttribute(records.get('104'), 'energy', 1500, 'Wh')), {
    state: 1.5,
  });
  assert.deepEqual(energy.read(records.get('104')), { state: 312.4 });
});

test('sensors, and buttons fed by events only', () => {
  assert.deepEqual(keys(mapped('110')), ['temperature', 'battery', 'contact']);
  const motion = mapped('111');
  assert.deepEqual(keys(motion), ['temperature', 'illuminance', 'battery', 'motion', 'tamper']);
  assert.deepEqual(read(motion, 'motion', records.get('111')), { state: 0 });
  assert.deepEqual(keys(mapped('112')), ['battery', 'water']);
  const smoke = mapped('113');
  assert.deepEqual(keys(smoke), ['battery', 'smoke', 'carbonMonoxide']);
  assert.equal(feature(smoke, 'carbonMonoxide').category, 'co-sensor');

  const remote = mapped('114');
  assert.equal(remote.buttons, 4);
  assert.deepEqual(keys(remote), ['battery', 'button_1', 'button_2', 'button_3', 'button_4']);
  const button = feature(remote, 'button_2');
  assert.equal(button.name, 'Télécommande – Bouton 2');
  assert.deepEqual([button.category, button.type, button.read_only], ['button', 'click', true]);
  assert.ok(!remote.readers.some((r) => r.key.startsWith('button')));
  assert.equal(BUTTON_STATUS.DOUBLE_CLICK, 2);

  assert.deepEqual(mapped('117').features, [], 'a speaker: nothing to offer yet');
});

test('the model: one device per hub device, stable external ids', () => {
  const idsOf = (id) => ({
    device: `ext:test:hubitat:${id}`,
    feature: (key) => `ext:test:hubitat:${id}:${key}`,
  });
  const model = buildModel(idsOf, records.values());
  assert.equal(model.devices.length, 16);
  assert.equal(model.counts.empty, 1);
  const lamp = model.devices.find((d) => d.external_id === 'ext:test:hubitat:101');
  assert.equal(lamp.name, 'Plafonnier (Salon)');
  assert.equal(lamp.should_poll, false);
  assert.deepEqual(lamp.params, [
    { name: 'HUBITAT_DEVICE_ID', value: '101' },
    { name: 'HUBITAT_ROOM', value: 'Salon' },
    { name: 'HUBITAT_DRIVER', value: 'Generic Zigbee Dimmer' },
  ]);
  assert.equal(
    model.devices.find((d) => d.external_id.endsWith(':105')).name,
    'Ventilation',
    'no room, no parentheses',
  );
  assert.equal(model.owners.get('ext:test:hubitat:108:lock'), '108');
  assert.equal(model.buttons.get('114').featureOf(3), 'ext:test:hubitat:114:button_3');
  for (const device of model.devices) {
    for (const f of device.features) {
      assert.ok(f.name.length <= 100);
      assert.ok(f.external_id.startsWith(`${device.external_id}:`));
    }
  }
});

test('colours, colour temperatures and temperatures convert both ways', () => {
  assert.equal(hsToRgbInt(0, 100), 0xff0000);
  assert.equal(hsToRgbInt(33.333, 100), 0x00ff00);
  assert.equal(hsToRgbInt(0, 0), 0xffffff);
  assert.deepEqual(rgbIntToHs(0x0000ff), { hue: 67, saturation: 100 });
  assert.deepEqual(rgbIntToHs(0xffffff), { hue: 0, saturation: 0 });
  assert.equal(kelvinToMireds(6500), 154);
  assert.equal(kelvinToMireds(9000), MIREDS.min);
  assert.equal(kelvinToMireds(2000), MIREDS.max);
  assert.equal(kelvinToMireds(0), undefined);
  assert.equal(miredsToKelvin(250), 4000);
  assert.equal(toCelsius(212, 'F'), 100);
  assert.equal(toCelsius(21.456, 'C'), 21.46);
  assert.equal(fromCelsius(21.2, 'C'), 21);
  assert.equal(fromCelsius(21.3, 'F'), 70);
  assert.equal(scaleOf('°F', 'C'), 'F');
  assert.equal(scaleOf(null, 'F'), 'F');
  assert.deepEqual(modeList('["heat","off"]'), ['heat', 'off']);
  assert.deepEqual(modeList('[heat, emergency heat]'), ['heat', 'emergency heat']);
  assert.deepEqual(modeList(undefined), []);
});

test('live events: device events only (the hacs-hubitat samples and the event socket shape)', () => {
  const events = fixture('events.json');
  assert.deepEqual(deviceEventOf(events.device), {
    deviceId: '176',
    name: 'switch',
    value: 'on',
    unit: undefined,
  });
  assert.equal(deviceEventOf(events.other), undefined);
  assert.equal(deviceEventOf(events.mode), undefined);
  assert.equal(deviceEventOf(events.hsmArmedAway), undefined);
  assert.deepEqual(
    deviceEventOf({
      source: 'DEVICE',
      name: 'temperature',
      value: '21.5',
      unit: '°C',
      deviceId: 111,
      hubId: 0,
      installedAppId: 0,
    }),
    { deviceId: '111', name: 'temperature', value: '21.5', unit: '°C' },
  );
  assert.equal(
    deviceEventOf({ source: 'LOCATION', name: 'hsmStatus', value: 'armedAway', deviceId: 0 }),
    undefined,
  );
  assert.equal(deviceEventOf('nonsense'), undefined);
});
