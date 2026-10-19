// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration) and the tuning of the integration.
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
};

// --- Plausibility of an energy index (the one Gladys bills), src/guard.js ----------
/** One Hubitat device (a plug, a module, a meter) never draws more than this on average. */
export const INDEX_MAX_KW = 25;
/** kWh always accepted on top of INDEX_MAX_KW × hours (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;

/** The state of the index guards kept in /data (src/store.js). */
export const STATE_FILE = '/data/hubitat-state.json';
export const STATE = {
  /** Index guards kept (one per energy feature of a created device). */
  maxEntries: 2000,
  /** Size of the file read back (bytes). */
  maxBytes: 1024 * 1024,
  /** Longest feature id kept. */
  maxKeyLength: 300,
  /** A reference that only rose is written at most this often (a hold, at once). */
  saveEvery: 60_000,
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Temperature scale of the hub (manifest `temperature_scale` options). */
export const TEMPERATURE_SCALES = ['C', 'F'];

/** Bounds of the number fields (seconds), mirrored by the manifest. */
export const SENSOR_INTERVAL = { min: 0, max: 300, default: 10 };
export const POLL_INTERVAL = { min: 10, max: 3600, default: 30 };

/**
 * The Maker API of the hub (Hubitat documentation, "Maker API"). Every path is
 * under /apps/api/<app id>/ and carries `?access_token=<token>`: never log a
 * URL of it.
 */
export const API = {
  base: (appId) => `/apps/api/${encodeURIComponent(appId)}`,
  /** The authorized devices, short: [{ id, name, label, type, room }] */
  devices: '/devices',
  /** The authorized devices with their capabilities, attributes and commands. */
  devicesAll: '/devices/all',
  device: (id) => `/devices/${encodeURIComponent(id)}`,
  /** One command; the Maker API takes one secondary value per path segment. */
  command: (id, command, args = []) =>
    [`/devices/${encodeURIComponent(id)}`, encodeURIComponent(command)]
      .concat(args.map((a) => encodeURIComponent(String(a))))
      .join('/'),
};

/** The live events of the hub: a WebSocket that pushes every event, as JSON. */
export const EVENTSOCKET_PATH = '/eventsocket';

/** Button events of Hubitat (PushableButton, HoldableButton, DoubleTapableButton, ReleasableButton). */
export const BUTTON_EVENTS = ['pushed', 'held', 'doubleTapped', 'released'];

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Size of a hub answer read (bytes): /devices/all of a big install is a few MB. */
  responseBytes: 16 * 1024 * 1024,
  /** Size of one live event (bytes): a few hundred in practice. */
  eventBytes: 64 * 1024,
  /** Devices published at once (publishDiscoveredDevices). */
  devices: 2000,
  /** Buttons of one device turned into features (numberOfButtons). */
  buttons: 20,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** One request (the device list gets `inventoryTimeout`). */
  requestTimeout: 15_000,
  inventoryTimeout: 60_000,
  /** One request of the connection test (the button waits 90 s). */
  testTimeout: 20_000,
  /** Opening the live socket. */
  liveTimeout: 10_000,
  /** With the live events, the whole device list is read again this often. */
  resync: 5 * 60_000,
  /** The live socket is opened again after a loss: this delay, doubled up to the max. */
  liveRetryMin: 5000,
  liveRetryMax: 2 * 60_000,
  /** Reconnection delays after a failure (doubled each time, up to the max). */
  retryMin: 5000,
  retryMax: 60_000,
  /** A refused token is retried slowly: the user has to change it. */
  authRetry: 5 * 60_000,
  /** Bounds of the pause after a 429 (Retry-After, or the minimum without it). */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 60 * 60_000,
  /** A device whose buttons changed: wait for the burst to end. */
  modelDebounce: 2000,
  /**
   * Gladys acks a set_value within 5 s: a command not sent within 3.5 s of
   * its arrival is refused, never sent late.
   */
  setValueDeadline: 3500,
  /** The command request may run this long past the deadline (the ack still fits in 5 s). */
  commandSlack: 1000,
  /** Shortest timeout of a request of a command. */
  commandTimeoutMin: 300,
  /** Without live events, a device is read back this soon after a command. */
  commandEcho: 1500,
  /**
   * After a lock or garage door command, the device is guarded: no other
   * guarded command until it reports the state asked for, or this long.
   */
  guard: { lock: 20_000, garage: 60_000 },
  /** The read backs of a guarded device (ms after the command; slow motors). */
  guardReadBacks: { lock: [5000, 15_000], garage: [5000, 15_000, 30_000, 60_000] },
  /** The event socket said nothing this long: it is opened again (watchdog). */
  liveSilence: 30 * 60_000,
  /** A refused socket is logged for its first failures, then once in this many. */
  liveWarnFirst: 3,
  liveWarnEvery: 10,
};
