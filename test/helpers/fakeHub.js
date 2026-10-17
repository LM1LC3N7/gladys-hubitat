// A fake Hubitat hub behind the client of src/hubitat.js and the event socket
// of src/eventsocket.js: the devices of the fixtures, the commands with their
// effect and their live echo, failures and refusals. Never the network.

import { readFileSync } from 'node:fs';
import { HubitatError } from '../../src/hubitat.js';
import { LiveError } from '../../src/eventsocket.js';

export const HUB_URL = 'http://192.168.1.50';
export const APP_ID = '12';
export const TOKEN = 'a1b2c3d4-0000-4000-8000-00000000beef';
export const CONFIG = { hub_address: '192.168.1.50', app_id: APP_ID, access_token: TOKEN };

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

/** The effect of a command on the attributes of a device (what a real hub would report). */
export function effect(attributes, command, args) {
  const [arg] = args;
  switch (command) {
    case 'on':
    case 'off':
      return { switch: command };
    case 'setLevel':
      return Number(arg) > 0 ? { level: Number(arg), switch: 'on' } : { level: 0 };
    case 'setColor': {
      const map = JSON.parse(arg);
      return {
        hue: map.hue,
        saturation: map.saturation,
        level: map.level,
        colorMode: 'RGB',
        switch: 'on',
      };
    }
    case 'setColorTemperature':
      return { colorTemperature: Number(arg), colorMode: 'CT', switch: 'on' };
    case 'open':
      return 'door' in attributes ? { door: 'open' } : { windowShade: 'open', position: 100 };
    case 'close':
      return 'door' in attributes ? { door: 'closed' } : { windowShade: 'closed', position: 0 };
    case 'stopPositionChange':
      return { windowShade: 'partially open' };
    case 'setPosition':
      return { position: Number(arg), windowShade: 'partially open' };
    case 'lock':
      return { lock: 'locked' };
    case 'unlock':
      return { lock: 'unlocked' };
    case 'setHeatingSetpoint':
      return { heatingSetpoint: Number(arg) };
    case 'setCoolingSetpoint':
      return { coolingSetpoint: Number(arg) };
    case 'setThermostatMode':
      return { thermostatMode: arg };
    default:
      return undefined;
  }
}

export function fakeHub({ token = TOKEN } = {}) {
  const box = {
    devices: fixture('devices-all.json'),
    /** every client call: { name, args } */
    calls: [],
    /** the commands run: { id, command, args } */
    executed: [],
    /** an error every call throws */
    fail: undefined,
    /** call name -> error that call throws */
    failOn: {},
    /** called on each device read (a test moves its clock there) */
    onDeviceRead: undefined,
    /** the error the event socket refuses with */
    liveRefusal: undefined,
    /** event sockets: { options, closed } */
    sessions: [],
    clients: [],
    /** whether a command echoes as live events */
    echo: true,
  };

  box.device = (id) => box.devices.find((d) => d.id === String(id));
  box.callsOf = (name) => box.calls.filter((c) => c.name === name);
  box.live = () => box.sessions.find((s) => !s.closed);

  /** An attribute changes on the hub: the device, then the live event to every socket. */
  box.emit = (id, name, value, { unit = null, source = 'DEVICE' } = {}) => {
    const device = box.device(id);
    if (device && !['pushed', 'held', 'doubleTapped', 'released'].includes(name)) {
      device.attributes[name] = value;
    }
    for (const session of box.sessions.filter((s) => !s.closed)) {
      session.options.onEvent?.({ deviceId: String(id), name, value, unit, source });
    }
  };

  /** The hub drops the event socket. */
  box.dropLive = (reason = 'connection closed') => {
    for (const session of box.sessions.filter((s) => !s.closed)) {
      session.closed = true;
      session.options.onClose?.(reason);
    }
  };

  async function call(name, args, run) {
    box.calls.push({ name, args });
    if (box.fail) {
      throw box.fail;
    }
    if (box.failOn[name]) {
      throw box.failOn[name];
    }
    return run();
  }

  /** The answer of GET /devices/<id>: attributes as a list, like the hub. */
  const details = (device) => ({
    id: device.id,
    name: device.name,
    label: device.label,
    type: device.type,
    room: device.room,
    capabilities: device.capabilities,
    commands: device.commands.map((c) => (typeof c === 'string' ? c : c.command)),
    attributes: Object.entries(device.attributes).map(([name, currentValue]) => ({
      name,
      currentValue,
      dataType: typeof currentValue === 'number' ? 'NUMBER' : 'STRING',
    })),
  });

  box.connect = (config) => {
    const signed = () => {
      if (config.token !== token) {
        throw new HubitatError('auth', 'access token refused (HTTP 401)', { status: 401 });
      }
      if (config.appId !== APP_ID) {
        throw new HubitatError('notfound', 'not found (HTTP 404)', { status: 404 });
      }
    };
    const client = {
      url: config.url,
      config,
      closed: false,
      devicesAll(options) {
        return call('devicesAll', { options }, () => {
          signed();
          return structuredClone(box.devices);
        });
      },
      device(id, options) {
        return call('device', { id, options }, () => {
          signed();
          box.onDeviceRead?.(id, options);
          options?.guard?.();
          const device = box.device(id);
          if (!device) {
            throw new HubitatError('notfound', 'not found (HTTP 404)', { status: 404 });
          }
          return structuredClone(details(device));
        });
      },
      command(id, command, args = [], options) {
        return call('command', { id, command, args, options }, () => {
          signed();
          options?.guard?.();
          const device = box.device(id);
          const changes = device && effect(device.attributes, command, args);
          if (!changes) {
            throw new HubitatError('notfound', 'not found (HTTP 404)', { status: 404 });
          }
          box.executed.push({ id: String(id), command, args });
          for (const [name, value] of Object.entries(changes)) {
            if (box.echo) {
              box.emit(id, name, value);
            } else {
              device.attributes[name] = value;
            }
          }
          return structuredClone(details(device));
        });
      },
      close() {
        client.closed = true;
      },
    };
    box.clients.push(client);
    return client;
  };

  /** Stands for openEventSocket(). */
  box.openLive = async (options) => {
    box.calls.push({ name: 'live', args: { url: options.url } });
    if (box.fail) {
      throw new LiveError('network', box.fail.message);
    }
    if (box.liveRefusal) {
      throw box.liveRefusal;
    }
    const session = { options, closed: false };
    session.close = () => {
      session.closed = true;
    };
    box.sessions.push(session);
    return session;
  };

  return box;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
