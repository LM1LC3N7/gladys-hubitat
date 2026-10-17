// -----------------------------------------------------------------------------
// One Hubitat device record -> Gladys features, readers and writers (pure).
//
// A Hubitat device lists its capabilities ("Switch", "SwitchLevel",
// "ColorControl", "WindowShade", "Lock"…), its attributes (switch, level,
// hue…) and its commands (on, off, setLevel…). The capability and attribute
// names, their values and the light heuristics follow jason0x43/hacs-hubitat
// (MIT, see THIRD_PARTY_NOTICES.md) and the Hubitat capability list.
// `mapDevice` returns:
//   features  the Gladys features (key: the Hubitat attribute, or `color`,
//             `door_command`, `button_<n>`; part of the external id: never
//             change a key),
//   readers   [{ key, attrs, read(record) -> { state } | null }]: `attrs` are
//             the attributes it reads (a live event of one of them runs it),
//   writers   { [key]: { write(value, record) -> [{ command, args }], safety? } }
//             one Maker API command per entry; `safety` ('lock' | 'garage')
//             marks the commands behind an option and a fresh read,
//   buttons   the number of buttons (features button_1…button_n), whose
//             presses only come as live events,
//   throttled the keys of the measurements (spaced by the sensor interval),
//   skipped   the capabilities left out.
// Value conventions: the Gladys side follows the enums of
// server/utils/constants.js in the Gladys core (copied here, the SDK does not
// export them).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { LIMITS } from './constants.js';
import { label } from './i18n.js';
import { numberAttr, stringAttr } from './records.js';

// Value enums of the Gladys core (server/utils/constants.js), not in the SDK.
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const LOCK_STATE = { UNLOCKED: 0, LOCKED: 1 };
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };
export const BUTTON_STATUS = {
  CLICK: 1,
  DOUBLE_CLICK: 2,
  LONG_CLICK_PRESS: 3,
  LONG_CLICK_RELEASE: 4,
};

/** Hubitat button event -> Gladys button status. */
export const BUTTON_STATES = {
  pushed: BUTTON_STATUS.CLICK,
  doubleTapped: BUTTON_STATUS.DOUBLE_CLICK,
  held: BUTTON_STATUS.LONG_CLICK_PRESS,
  released: BUTTON_STATUS.LONG_CLICK_RELEASE,
};

/** windowShade / windowBlind -> Gladys cover state (moving = the way it goes). */
const SHADE_STATES = {
  open: COVER_STATE.OPEN,
  opening: COVER_STATE.OPEN,
  closed: COVER_STATE.CLOSE,
  closing: COVER_STATE.CLOSE,
  'partially open': COVER_STATE.STOP,
};

const THERMOSTAT_MODES = {
  off: THERMOSTAT_MODE.OFF,
  heat: THERMOSTAT_MODE.HEATING,
  'emergency heat': THERMOSTAT_MODE.HEATING,
  cool: THERMOSTAT_MODE.COOLING,
  auto: THERMOSTAT_MODE.AUTO,
};
const MODE_COMMANDS = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto' };

const OPERATING_STATES = {
  idle: THERMOSTAT_OPERATING_STATE.IDLE,
  'fan only': THERMOSTAT_OPERATING_STATE.IDLE,
  'vent economizer': THERMOSTAT_OPERATING_STATE.IDLE,
  heating: THERMOSTAT_OPERATING_STATE.HEATING,
  'pending heat': THERMOSTAT_OPERATING_STATE.HEATING,
  cooling: THERMOSTAT_OPERATING_STATE.COOLING,
  'pending cool': THERMOSTAT_OPERATING_STATE.COOLING,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const cut = (s, max = 100) => String(s ?? '').slice(0, max);

// --- Temperatures ------------------------------------------------------------------

/** The scale of a temperature: its unit when the hub gave one, else the configured one. */
export function scaleOf(unit, fallback) {
  if (typeof unit === 'string') {
    if (/F/i.test(unit)) {
      return 'F';
    }
    if (/C/i.test(unit)) {
      return 'C';
    }
  }
  return fallback;
}

/** A hub temperature -> °C (Gladys features are always in °C). */
export function toCelsius(value, scale) {
  return round(scale === 'F' ? ((value - 32) * 5) / 9 : value);
}

/** A °C setpoint -> the hub scale: whole °F, half °C. */
export function fromCelsius(value, scale) {
  return scale === 'F' ? Math.round((value * 9) / 5 + 32) : Math.round(value * 2) / 2;
}

// --- Colours -----------------------------------------------------------------------

export const colorToInt = (r, g, b) =>
  ((Number(r) & 255) << 16) | ((Number(g) & 255) << 8) | (Number(b) & 255);

/** Hubitat hue and saturation (0…100) -> an RGB integer, at full value. */
export function hsToRgbInt(hue, saturation) {
  const h = ((((Number(hue) / 100) % 1) + 1) % 1) * 6;
  const s = clamp(Number(saturation) / 100, 0, 1);
  const i = Math.floor(h);
  const f = h - i;
  const p = 1 - s;
  const q = 1 - s * f;
  const t = 1 - s * (1 - f);
  const [r, g, b] = [
    [1, t, p],
    [q, 1, p],
    [p, 1, t],
    [p, q, 1],
    [t, p, 1],
    [1, p, q],
  ][i % 6];
  return colorToInt(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

/** An RGB integer -> Hubitat hue and saturation (0…100). */
export function rgbIntToHs(n) {
  const rgb = clamp(Math.round(Number(n) || 0), 0, 0xffffff);
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) {
      h = ((g - b) / d) % 6;
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h /= 6;
    if (h < 0) {
      h += 1;
    }
  }
  return {
    hue: Math.round(h * 100) % 100,
    saturation: Math.round(max === 0 ? 0 : (d / max) * 100),
  };
}

/** Gladys colour temperatures in mireds (Hubitat: kelvins). */
export const MIREDS = { min: 153, max: 500 };
export const kelvinToMireds = (k) =>
  k > 0 ? clamp(Math.round(1e6 / k), MIREDS.min, MIREDS.max) : undefined;
export const miredsToKelvin = (m) =>
  Math.round(1e6 / clamp(Number(m) || MIREDS.min, MIREDS.min, MIREDS.max));

/** supportedThermostatModes: '["heat","off"]', "[heat, off]" or a list. */
export function modeList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((m) => String(m).trim());
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.map((m) => String(m).trim());
    }
  } catch {
    // Groovy's "[heat, off]": read below.
  }
  return raw
    .replace(/^\s*\[|\]\s*$/g, '')
    .split(',')
    .map((m) => m.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// --- Specs -------------------------------------------------------------------------

const decimal = (category, min, max, unit, type = T.SENSOR.DECIMAL) => ({
  category,
  type,
  min,
  max,
  unit,
});

/** Read-only measurements: attribute -> [capabilities giving it, spec]. */
const MEASURES = {
  humidity: [['RelativeHumidityMeasurement'], decimal(C.HUMIDITY_SENSOR, 0, 100, U.PERCENT)],
  illuminance: [['IlluminanceMeasurement'], decimal(C.LIGHT_SENSOR, 0, 200_000, U.LUX)],
  carbonDioxide: [['CarbonDioxideMeasurement'], decimal(C.CO2_SENSOR, 0, 100_000, U.PPM)],
  ultravioletIndex: [['UltravioletIndex'], decimal(C.UV_SENSOR, 0, 20, U.UV_INDEX)],
  voltage: [
    ['VoltageMeasurement'],
    decimal(C.ENERGY_SENSOR, 0, 100_000, U.VOLT, T.ENERGY_SENSOR.VOLTAGE),
  ],
  amperage: [
    ['CurrentMeter'],
    decimal(C.ENERGY_SENSOR, 0, 100_000, U.AMPERE, T.ENERGY_SENSOR.CURRENT),
  ],
  battery: [['Battery'], decimal(C.BATTERY, 0, 100, U.PERCENT, T.BATTERY.INTEGER)],
};

/** Power and energy: on the switch of a plug, or an energy sensor. */
const POWER = {
  switch: decimal(C.SWITCH, 0, 1e9, U.WATT, T.SWITCH.POWER),
  sensor: decimal(C.ENERGY_SENSOR, -1e9, 1e9, U.WATT, T.ENERGY_SENSOR.POWER),
};
// Hubitat's `energy` is a cumulative meter (kWh), what the core expects of these types.
const ENERGY = {
  switch: decimal(C.SWITCH, 0, 1e12, U.KILOWATT_HOUR, T.SWITCH.ENERGY),
  sensor: decimal(C.ENERGY_SENSOR, 0, 1e12, U.KILOWATT_HOUR, T.ENERGY_SENSOR.INDEX),
};

/** Two-state sensors: attribute -> capabilities, category, type, value -> 1, value -> 0. */
const BINARIES = {
  contact: {
    caps: ['ContactSensor'],
    category: C.OPENING_SENSOR,
    type: T.SENSOR.BINARY,
    // Gladys: OPEN 0, CLOSE 1.
    values: { open: OPENING_SENSOR_STATE.OPEN, closed: OPENING_SENSOR_STATE.CLOSE },
  },
  motion: {
    caps: ['MotionSensor'],
    category: C.MOTION_SENSOR,
    type: T.SENSOR.BINARY,
    values: { active: 1, inactive: 0 },
  },
  water: {
    caps: ['WaterSensor'],
    category: C.LEAK_SENSOR,
    type: T.SENSOR.BINARY,
    values: { wet: 1, dry: 0 },
  },
  smoke: {
    caps: ['SmokeDetector'],
    category: C.SMOKE_SENSOR,
    type: T.SENSOR.BINARY,
    values: { detected: 1, clear: 0, tested: 0 },
  },
  carbonMonoxide: {
    caps: ['CarbonMonoxideDetector'],
    category: C.CO_SENSOR,
    type: T.SENSOR.BINARY,
    values: { detected: 1, clear: 0, tested: 0 },
  },
  tamper: {
    caps: ['TamperAlert'],
    category: C.TAMPER,
    type: T.TAMPER.BINARY,
    values: { detected: 1, clear: 0 },
  },
  presence: {
    caps: ['PresenceSensor'],
    category: C.PRESENCE_SENSOR,
    type: T.SENSOR.BINARY,
    values: { present: 1, 'not present': 0 },
  },
};

/** Capabilities read through others, or with nothing to show (no warning). */
const QUIET = new Set([
  'Actuator',
  'Sensor',
  'Configuration',
  'Refresh',
  'Polling',
  'Initialize',
  'HealthCheck',
  'Outlet',
  'Light',
  'Bulb',
  'RelaySwitch',
  'ColorMode',
  'ChangeLevel',
  'LevelPreset',
  'Thermostat',
  'ThermostatMode',
  'ThermostatOperatingState',
  'ThermostatSetpoint',
  'ThermostatHeatingSetpoint',
  'ThermostatCoolingSetpoint',
  'ThermostatFanMode',
  'TemperatureMeasurement',
  'PowerMeter',
  'EnergyMeter',
  'PushableButton',
  'HoldableButton',
  'DoubleTapableButton',
  'ReleasableButton',
  'GarageDoorControl',
  'DoorControl',
  'Switch',
  'SwitchLevel',
  'ColorControl',
  'ColorTemperature',
  'WindowShade',
  'WindowBlind',
  'Lock',
  ...Object.values(MEASURES).flatMap(([caps]) => caps),
  ...Object.values(BINARIES).flatMap((b) => b.caps),
]);

// --- The device --------------------------------------------------------------------

class DeviceMapper {
  /**
   * @param {object} record see src/records.js
   * @param {{ language: 'fr'|'en', scale: 'C'|'F' }} options
   */
  constructor(record, { language = 'fr', scale = 'C' } = {}) {
    this.r = record;
    this.language = language;
    this.scale = scale;
    this.name = (record.label || record.name || `Hubitat ${record.id}`).trim();
    this.caps = record.capabilities;
    this.has = (cap) => this.caps.has(cap);
    this.hasAttr = (name) => record.attributes.has(name);
    this.features = [];
    this.readers = [];
    this.writers = {};
    this.throttled = new Set();
    this.skipped = [];
    this.buttons = 0;
    this.cover = this.has('WindowShade') || this.has('WindowBlind');
    this.garage = this.has('GarageDoorControl') || this.has('DoorControl');
    this.valve = this.has('Valve');
    this.light =
      this.has('ColorControl') ||
      this.has('ColorTemperature') ||
      this.has('Light') ||
      this.has('Bulb') ||
      (this.has('SwitchLevel') && !this.cover && !this.has('FanControl') && !this.has('Outlet'));
  }

  /** A command the device offers (an answer without the command list allows them all). */
  can(command) {
    return this.r.commands.size === 0 || this.r.commands.has(command);
  }

  nameOf(key, ...args) {
    return cut(`${this.name} – ${label(key, this.language, ...args)}`);
  }

  /**
   * One feature.
   * @param {string} key part of the external id: never change it
   * @param {string[]} attrs the attributes it reads
   * @param {{ read?: Function, write?: Function, safety?: string, throttle?: boolean, feedback?: boolean }} io
   */
  add(key, name, attrs, spec, { read, write, safety, throttle = false, feedback } = {}) {
    if (this.features.some((f) => f.key === key)) {
      return;
    }
    const feature = {
      key,
      name: cut(name),
      category: spec.category,
      type: spec.type,
      min: spec.min ?? 0,
      max: spec.max ?? 1,
      read_only: !write,
      has_feedback: feedback ?? Boolean(write && read),
      keep_history: true,
    };
    if (spec.unit) {
      feature.unit = spec.unit;
    }
    this.features.push(feature);
    if (read) {
      this.readers.push({ key, attrs, read });
    }
    if (write) {
      this.writers[key] = safety ? { write, safety } : { write };
    }
    if (throttle) {
      this.throttled.add(key);
    }
  }

  /** An attribute whose values map to numbers (`values`), unknown values read as nothing. */
  enumRead(attr, values) {
    return (r) => {
      const v = stringAttr(r, attr);
      return v !== undefined && Object.hasOwn(values, v) ? { state: values[v] } : null;
    };
  }

  // --- Switches and lights -----------------------------------------------------

  onoff() {
    const [category, type] = this.light ? [C.LIGHT, T.LIGHT.BINARY] : [C.SWITCH, T.SWITCH.BINARY];
    // A valve driven as a switch stays read-only: closing or opening water is not a switch.
    const writable = !this.valve && this.can('on') && this.can('off');
    this.add(
      'switch',
      cut(this.name),
      ['switch'],
      { category, type, min: 0, max: 1 },
      {
        read: this.enumRead('switch', { on: 1, off: 0 }),
        write: writable
          ? (value) => [{ command: Number(value) > 0 ? 'on' : 'off', args: [] }]
          : undefined,
      },
    );
  }

  level() {
    const spec = this.light
      ? { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100 }
      : { category: C.SWITCH, type: T.SWITCH.DIMMER, min: 0, max: 100 };
    this.add('level', this.nameOf('level'), ['level'], spec, {
      read: (r) => {
        const v = numberAttr(r, 'level');
        return v === undefined ? null : { state: clamp(Math.round(v), 0, 100) };
      },
      write: this.can('setLevel')
        ? (value) => [
            { command: 'setLevel', args: [clamp(Math.round(Number(value) || 0), 0, 100)] },
          ]
        : undefined,
    });
  }

  color() {
    this.add(
      'color',
      this.nameOf('color'),
      ['hue', 'saturation', 'colorMode'],
      { category: C.LIGHT, type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
      {
        read: (r) => {
          const hue = numberAttr(r, 'hue');
          const saturation = numberAttr(r, 'saturation');
          if (
            stringAttr(r, 'colorMode') === 'CT' ||
            hue === undefined ||
            saturation === undefined
          ) {
            return null;
          }
          return { state: hsToRgbInt(hue, saturation) };
        },
        write: this.can('setColor')
          ? (value, r) => {
              const { hue, saturation } = rgbIntToHs(value);
              const level = numberAttr(r, 'level');
              const map = { hue, saturation, level: level > 0 ? Math.round(level) : 100 };
              return [{ command: 'setColor', args: [JSON.stringify(map)] }];
            }
          : undefined,
      },
    );
  }

  colorTemperature() {
    this.add(
      'colorTemperature',
      this.nameOf('colorTemperature'),
      ['colorTemperature', 'colorMode'],
      { category: C.LIGHT, type: T.LIGHT.TEMPERATURE, min: MIREDS.min, max: MIREDS.max },
      {
        read: (r) => {
          if (stringAttr(r, 'colorMode') === 'RGB') {
            return null;
          }
          const mireds = kelvinToMireds(numberAttr(r, 'colorTemperature'));
          return mireds === undefined ? null : { state: mireds };
        },
        write: this.can('setColorTemperature')
          ? (value) => [{ command: 'setColorTemperature', args: [miredsToKelvin(value)] }]
          : undefined,
      },
    );
  }

  // --- Covers ------------------------------------------------------------------------

  shade() {
    const attr = this.hasAttr('windowShade') ? 'windowShade' : 'windowBlind';
    const stop = ['stopPositionChange', 'stop'].find(
      (c) => this.r.commands.size > 0 && this.r.commands.has(c),
    );
    const name = cut(this.name);
    this.add(
      'windowShade',
      name,
      [attr],
      { category: C.SHUTTER, type: T.SHUTTER.STATE, min: -1, max: 1 },
      {
        read: this.enumRead(attr, SHADE_STATES),
        write: (value) => {
          const v = Number(value);
          if (v === COVER_STATE.OPEN && this.can('open')) {
            return [{ command: 'open', args: [] }];
          }
          if (v === COVER_STATE.CLOSE && this.can('close')) {
            return [{ command: 'close', args: [] }];
          }
          if (v === COVER_STATE.STOP && stop) {
            return [{ command: stop, args: [] }];
          }
          throw Object.assign(new Error('unsupported'), { refusal: 'unsupported' });
        },
      },
    );
    const positionAttr = this.hasAttr('position') ? 'position' : 'level';
    if (this.hasAttr(positionAttr) || this.can('setPosition')) {
      this.add(
        'position',
        this.nameOf('position'),
        [positionAttr],
        { category: C.SHUTTER, type: T.SHUTTER.POSITION, min: 0, max: 100 },
        {
          read: (r) => {
            const v = numberAttr(r, positionAttr);
            return v === undefined ? null : { state: clamp(Math.round(v), 0, 100) };
          },
          write:
            this.r.commands.size === 0 || this.r.commands.has('setPosition')
              ? (value) => [
                  {
                    command: 'setPosition',
                    args: [clamp(Math.round(Number(value) || 0), 0, 100)],
                  },
                ]
              : undefined,
        },
      );
    }
  }

  // --- Locks and garage doors (read-only unless the user allows them) -------------

  lock() {
    this.add(
      'lock',
      cut(this.name),
      ['lock'],
      { category: C.LOCK, type: T.LOCK.BINARY, min: 0, max: 1 },
      {
        read: this.enumRead('lock', {
          locked: LOCK_STATE.LOCKED,
          unlocked: LOCK_STATE.UNLOCKED,
          'unlocked with timeout': LOCK_STATE.UNLOCKED,
        }),
        // Always declared writable (features are frozen at creation); refused
        // unless `allow_lock_control` is on, on a state read just before.
        write: (value) => [{ command: Number(value) > 0 ? 'lock' : 'unlock', args: [] }],
        safety: 'lock',
      },
    );
  }

  garageDoor() {
    this.add(
      'door',
      this.nameOf('door'),
      ['door'],
      { category: C.OPENING_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 },
      {
        read: this.enumRead('door', {
          open: OPENING_SENSOR_STATE.OPEN,
          opening: OPENING_SENSOR_STATE.OPEN,
          closing: OPENING_SENSOR_STATE.OPEN,
          closed: OPENING_SENSOR_STATE.CLOSE,
        }),
      },
    );
    this.add(
      'door_command',
      this.nameOf('door_command'),
      ['door'],
      { category: C.SWITCH, type: T.SWITCH.BINARY, min: 0, max: 1 },
      {
        // 1 open (or opening), 0 closed (or closing).
        read: this.enumRead('door', { open: 1, opening: 1, closed: 0, closing: 0 }),
        write: (value) => [{ command: Number(value) > 0 ? 'open' : 'close', args: [] }],
        safety: 'garage',
      },
    );
  }

  // --- Climate -----------------------------------------------------------------------

  temperatureRead(attr) {
    return (r) => {
      const v = numberAttr(r, attr);
      if (v === undefined) {
        return null;
      }
      return { state: toCelsius(v, scaleOf(r.attributes.get(attr)?.unit, this.scale)) };
    };
  }

  setpoint(attr, command) {
    this.add(
      attr,
      this.nameOf(attr),
      [attr],
      {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        min: 5,
        max: 35,
        unit: U.CELSIUS,
      },
      {
        read: this.temperatureRead(attr),
        write: this.can(command)
          ? (value, r) => {
              const celsius = clamp(Number(value), 5, 35);
              if (!Number.isFinite(celsius)) {
                throw Object.assign(new Error('bad value'), { refusal: 'badValue' });
              }
              const scale = scaleOf(r?.attributes.get(attr)?.unit, this.scale);
              return [{ command, args: [fromCelsius(celsius, scale)] }];
            }
          : undefined,
      },
    );
  }

  thermostatMode() {
    this.add(
      'thermostatMode',
      this.nameOf('thermostatMode'),
      ['thermostatMode'],
      { category: C.THERMOSTAT, type: T.THERMOSTAT.MODE, min: 0, max: 3 },
      {
        read: this.enumRead('thermostatMode', THERMOSTAT_MODES),
        write: this.can('setThermostatMode')
          ? (value, r) => {
              const mode = MODE_COMMANDS[Number(value)];
              const supported = modeList(stringAttr(r, 'supportedThermostatModes'));
              if (!mode || (supported.length > 0 && !supported.includes(mode))) {
                throw Object.assign(new Error('unsupported'), { refusal: 'unsupported' });
              }
              return [{ command: 'setThermostatMode', args: [mode] }];
            }
          : undefined,
      },
    );
  }

  operatingState() {
    this.add(
      'thermostatOperatingState',
      this.nameOf('thermostatOperatingState'),
      ['thermostatOperatingState'],
      { category: C.THERMOSTAT, type: T.THERMOSTAT.OPERATING_STATE, min: 0, max: 2 },
      { read: this.enumRead('thermostatOperatingState', OPERATING_STATES) },
    );
  }

  // --- Sensors -----------------------------------------------------------------------

  measure(attr, spec, read) {
    this.add(attr, this.nameOf(attr), [attr], spec, {
      read:
        read ??
        ((r) => {
          const v = numberAttr(r, attr);
          if (v === undefined) {
            return null;
          }
          return { state: spec.type === T.BATTERY.INTEGER ? clamp(Math.round(v), 0, 100) : v };
        }),
      throttle: true,
    });
  }

  binary(attr, { category, type, values }) {
    this.add(
      attr,
      this.nameOf(attr),
      [attr],
      { category, type, min: 0, max: 1 },
      {
        read: this.enumRead(attr, values),
      },
    );
  }

  /** The buttons: one feature per button number, fed by the live events only. */
  buttonFeatures() {
    const declared = numberAttr(this.r, 'numberOfButtons');
    const count = clamp(
      Number.isInteger(declared) && declared > 0 ? declared : 1,
      1,
      LIMITS.buttons,
    );
    this.buttons = count;
    for (let n = 1; n <= count; n += 1) {
      this.add(
        `button_${n}`,
        count === 1 ? this.nameOf('button') : this.nameOf('buttonN', n),
        [],
        { category: C.BUTTON, type: T.BUTTON.CLICK, min: 0, max: 104 },
        { feedback: false },
      );
    }
  }

  // --- The device --------------------------------------------------------------------

  map() {
    const isButton = [
      'PushableButton',
      'HoldableButton',
      'DoubleTapableButton',
      'ReleasableButton',
    ].some((c) => this.has(c));
    const isThermostat =
      this.has('Thermostat') ||
      this.has('ThermostatHeatingSetpoint') ||
      this.has('ThermostatCoolingSetpoint');
    if (this.has('Switch') && this.hasAttr('switch')) {
      this.onoff();
    }
    if (this.cover) {
      this.shade();
    } else if (this.has('SwitchLevel') && this.hasAttr('level')) {
      this.level();
    }
    if (this.has('ColorControl') && this.hasAttr('hue') && this.hasAttr('saturation')) {
      this.color();
    }
    if (this.has('ColorTemperature') && this.hasAttr('colorTemperature')) {
      this.colorTemperature();
    }
    if (this.has('Lock') && this.hasAttr('lock')) {
      this.lock();
    }
    if (this.garage && this.hasAttr('door')) {
      this.garageDoor();
    }
    if (isThermostat) {
      if (this.hasAttr('heatingSetpoint')) {
        this.setpoint('heatingSetpoint', 'setHeatingSetpoint');
      }
      if (this.hasAttr('coolingSetpoint')) {
        this.setpoint('coolingSetpoint', 'setCoolingSetpoint');
      }
      if (this.hasAttr('thermostatMode')) {
        this.thermostatMode();
      }
      if (this.hasAttr('thermostatOperatingState')) {
        this.operatingState();
      }
    }
    if ((this.has('TemperatureMeasurement') || isThermostat) && this.hasAttr('temperature')) {
      this.measure(
        'temperature',
        decimal(C.TEMPERATURE_SENSOR, -100, 150, U.CELSIUS),
        this.temperatureRead('temperature'),
      );
    }
    for (const [attr, [caps, spec]] of Object.entries(MEASURES)) {
      if (caps.some((c) => this.has(c)) && this.hasAttr(attr)) {
        this.measure(attr, spec);
      }
    }
    const hasSwitch = this.features.some((f) => f.key === 'switch');
    if (this.has('PowerMeter') && this.hasAttr('power')) {
      this.measure('power', hasSwitch ? POWER.switch : POWER.sensor);
    }
    if (this.has('EnergyMeter') && this.hasAttr('energy')) {
      this.measure('energy', hasSwitch ? ENERGY.switch : ENERGY.sensor);
    }
    for (const [attr, spec] of Object.entries(BINARIES)) {
      if (spec.caps.some((c) => this.has(c)) && this.hasAttr(attr)) {
        this.binary(attr, spec);
      }
    }
    if (isButton) {
      this.buttonFeatures();
    }
    for (const cap of this.caps) {
      if (!QUIET.has(cap)) {
        this.skipped.push(cap);
      }
    }
    return {
      features: this.features,
      readers: this.readers,
      writers: this.writers,
      buttons: this.buttons,
      throttled: this.throttled,
      skipped: this.skipped,
    };
  }
}

/**
 * One Hubitat device record -> features, readers, writers.
 * @param {object} record see src/records.js
 * @param {{ language?: 'fr'|'en', scale?: 'C'|'F' }} [options]
 */
export function mapDevice(record, options) {
  return new DeviceMapper(record, options).map();
}
