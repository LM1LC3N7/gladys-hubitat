// -----------------------------------------------------------------------------
// The integration: one Hubitat Elevation hub, the devices authorized in its
// Maker API turned into Gladys devices, the live events feeding the states,
// and the commands sent back. index.js only wires the SDK handlers to it.
//
// Lifecycle: start -> open (GET /devices/all) -> the event socket
// (src/eventsocket.js) brings every change, and the whole device list is read
// again every 5 minutes (missed events, renames, devices authorized since).
// Without the socket (off in the configuration, refused, lost), the list is
// read at the configured pace and the socket is tried again in the
// background. A watchdog opens the socket again when a read finds a change no
// event told, or when the socket stayed silent too long. On a failure of the
// Maker API, reconnect with a growing delay; a 429 pauses every path.
//
// Commands: one at a time per device, sent within 3.5 s of their arrival or
// refused; locks and garage doors only when the user allowed them, on a state
// read just before, then guarded until the device reports the state asked
// for. No HSM or mode command exists in this integration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_TRANSPORTS,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { BUTTON_EVENTS, INDEX_MAX_KW, INDEX_SLACK_KWH, STATE, TIMINGS } from './constants.js';
import { buildModel, emptyModel } from './devices.js';
import { LiveError, openEventSocket } from './eventsocket.js';
import { IndexGuard } from './guard.js';
import { HubitatError, createClient } from './hubitat.js';
import { T, scaleMismatch, word } from './i18n.js';
import { BUTTON_STATES, BUTTON_STATUS, scaleOf } from './mapping.js';
import { StatePublisher } from './publisher.js';
import {
  mergeRecord,
  numberAttr,
  recordOf,
  recordsOf,
  stringAttr,
  withAttribute,
} from './records.js';
import { createFileStore } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const HOUR = 3_600_000;

/**
 * The identity of a hold, for the log and /data: a jump by its threshold, a drop
 * by where it dropped from only (the low value of a reset meter rises with each
 * reading: one hold, not one per reading).
 */
const holdKey = (held) =>
  held.direction === 'down' ? ['down', held.from] : ['up', held.from, held.threshold];

/** The feature of a created device, from the devices Gladys gave (kept up to date by the SDK). */
function createdFeature(devices, featureId) {
  for (const device of devices ?? []) {
    const feature = (device.features ?? []).find((f) => f.external_id === featureId);
    if (feature) {
      return feature;
    }
  }
  return undefined;
}

/** The index Gladys already holds for a feature (`last_value`, `last_value_changed`), when it says so. */
function lastValueOf(feature) {
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** What /data keeps of a guard, compared to know when to write it: the hold apart. */
function stateKeys({ last, held }) {
  const hold = JSON.stringify(held && holdKey(held));
  return { hold, all: JSON.stringify([last, hold]) };
}

/** Lock and garage door states, normalized: 1 locked / open, 0 unlocked / closed. */
const LOCK_KNOWN = { locked: 1, unlocked: 0, 'unlocked with timeout': 0 };
const DOOR_KNOWN = { open: 1, closed: 0, opening: 'moving', closing: 'moving' };

/** The state of the device a guarded command acts on (undefined when unknown). */
function guardedState(record, safety) {
  const known = safety === 'lock' ? LOCK_KNOWN : DOOR_KNOWN;
  const raw = stringAttr(record, safety === 'lock' ? 'lock' : 'door');
  return raw !== undefined && Object.hasOwn(known, raw) ? known[raw] : undefined;
}

/** Two-state attributes the watchdog compares between a read and the events. */
const WATCHED = new Set([
  'switch',
  'contact',
  'motion',
  'water',
  'smoke',
  'carbonMonoxide',
  'tamper',
  'presence',
  'lock',
  'door',
]);

/** Temperature attributes whose event unit tells the scale of the hub. */
const TEMPERATURES = new Set([
  'temperature',
  'heatingSetpoint',
  'coolingSetpoint',
  'thermostatSetpoint',
]);

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class HubitatApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hubitat' }),
    connect = createClient,
    live = openEventSocket,
    WebSocket = globalThis.WebSocket,
    now = Date.now,
    timers = globalThis,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    /** /data: per energy feature, the index reference and the value held, across restarts. */
    this.store = store;
    this.logger = logger;
    this.connect = connect;
    this.openLive = live;
    this.WebSocket = WebSocket;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    this.client = null;
    this.model = emptyModel();
    /** hub device id -> last record (replaced, never mutated) */
    this.records = new Map();
    /** live events are numbered: a read keeps those numbered after its start */
    this.eventSeq = 0;
    /** when (ms) the read that gave `records` started */
    this.readStartedAt = -Infinity;
    this.online = false;
    /** the live socket, and its state: off | connecting | live | down */
    this.live = null;
    this.liveState = 'off';
    this.liveError = undefined;
    this.liveFailures = 0;
    this.liveOpening = undefined;
    this.liveSince = Infinity;
    this.lastMessageAt = 0;
    this.running = false;
    /** feature id -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** device id -> last badge published (JSON) */
    this.transports = new Map();
    /** hub device id -> the tail of its command chain */
    this.chains = new Map();
    /** hub device id -> { safety, expected, start, sawMoving, until, timer } */
    this.guards = new Map();
    /** hub device ids whose state was not confirmed after a guarded command */
    this.unconfirmed = new Set();
    /** "<device>:<button>" held and not released yet */
    this.held = new Set();
    /**
     * energy feature id -> IndexGuard (src/guard.js), built from Gladys and
     * /data when the feature is created. Kept across restarts of the app (a
     * save of the form, a reconnection): neither accepts anything.
     */
    this.indexGuards = new Map();
    /** energy feature id -> the last value read from the hub (not always the one sent) */
    this.indexesRead = new Map();
    /** The state read back from /data (once), then kept up to date. */
    this.savedState = undefined;
    /** energy feature id -> { hold, all } last written to /data */
    this.savedKeys = new Map();
    /** energy feature id -> the hold last logged */
    this.holdLogged = new Map();
    /** energy feature id -> { from, since, timer }: a drop held, shown once it lasted */
    this.drops = new Map();
    /** The first click of "Accept the held index": { fingerprint, at } */
    this.pendingAccept = undefined;
    this.stateDirty = false;
    this.stateTimer = undefined;
    this.stateWrite = Promise.resolve();
    /** the scale the hub's events gave ('C' | 'F'), and whether it differs from the option */
    this.hubScale = undefined;
    this.scaleMismatch = false;
    /** a 429 pauses every path until then (survives a reconnection to Gladys) */
    this.pausedUntil = 0;
    this.readBackTimers = new Set();
    this.timer = undefined;
    this.modelTimer = undefined;
    this.liveTimer = undefined;
    this.reading = false;
    this.failures = 0;
    this.lastError = undefined;
    this.generation = 0;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.warned = new Set();
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    this.config = normalizeConfig(raw);
    this.refreshCreated();
    if (this.config.error) {
      await this.setStatus(false, T.configError(this.config.error));
      return;
    }
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
    this.running = true;
    this.publisher.start();
    const paused = this.pausedUntil - this.now();
    if (paused > 0) {
      // A 429 pause outlives a restart: wait for its end.
      await this.setStatus(false, T.failure({ kind: 'rate' }));
      this.schedule(generation, paused, () => this.open(generation));
      return;
    }
    await this.setStatus(false, T.connecting);
    await this.open(generation);
  }

  /**
   * Gladys (re)connected: the same configuration keeps everything (client,
   * 429 pause, refused token waiting its retry) and publishes again what
   * Gladys may have missed; another one starts again.
   */
  async resume(raw = {}) {
    if (!this.running || !sameConfig(normalizeConfig(raw), this.config)) {
      await this.start(raw);
      return;
    }
    this.refreshCreated();
    this.lastStatus = undefined;
    this.transports.clear();
    if (this.online) {
      this.publishedDevices = undefined;
      await this.rebuild();
      await this.connectedStatus();
    } else {
      await this.setStatus(false, this.lastError ? T.failure(this.lastError) : T.connecting);
    }
    await this.publishAllTransports();
  }

  /** The configuration changed: start again with it. */
  async configUpdated(raw = {}) {
    this.logger.info('Configuration updated: reconnecting to the Hubitat hub');
    await this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    for (const timer of [
      this.timer,
      this.modelTimer,
      this.liveTimer,
      this.stateTimer,
      ...this.readBackTimers,
    ]) {
      this.timers.clearTimeout(timer);
    }
    for (const drop of this.drops.values()) {
      // Kept (its start stays): a drop that lasted is told at the next value read.
      this.timers.clearTimeout(drop.timer);
    }
    for (const guard of this.guards.values()) {
      this.timers.clearTimeout(guard.timer);
    }
    this.guards.clear();
    this.readBackTimers.clear();
    this.timer = undefined;
    this.modelTimer = undefined;
    this.liveTimer = undefined;
    if (this.stateTimer !== undefined) {
      // A reference not written yet: written now (a hold always is at once).
      this.stateTimer = undefined;
      this.background(this.writeState());
    }
    this.publisher.stop();
    this.closeLive('off');
    this.client?.close?.();
    this.client = null;
    this.online = false;
    this.reading = false;
    this.failures = 0;
    this.liveFailures = 0;
  }

  current(generation) {
    return generation === this.generation;
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async connectedStatus() {
    const message = T.connected(
      this.model.devices.length,
      this.liveState,
      this.liveError,
      this.config.pollInterval,
    );
    if (this.scaleMismatch) {
      const extra = scaleMismatch(this.hubScale);
      message.en = `${message.en} ${extra.en}`;
      message.fr = `${message.fr} ${extra.fr}`;
    }
    await this.setStatus(true, message);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /** Runs `fn` after `ms` on the main timer, unless the app was restarted or stopped meanwhile. */
  schedule(generation, ms, fn) {
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.current(generation)) {
        fn().catch((err) => this.logger.error(`Hubitat loop: ${err.message}`));
      }
    }, ms);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(err.message));
  }

  // --- Connection ----------------------------------------------------------------

  async open(generation) {
    try {
      this.client?.close?.();
      const { url, appId, token } = this.config;
      this.client = this.connect({ url, appId, token });
      await this.loadAll(generation);
      if (!this.current(generation)) {
        return;
      }
      this.online = true;
      this.failures = 0;
      this.lastError = undefined;
      this.logger.info(
        `Connected to the Maker API app ${appId} at ${url}: ${this.model.devices.length} devices offered`,
      );
      this.liveState = this.config.live ? 'connecting' : 'off';
      await this.connectedStatus();
      await this.publishAllTransports();
      this.scheduleRead(generation);
      if (this.config.live) {
        this.startLive(generation);
      }
    } catch (err) {
      await this.fail(generation, err);
    }
  }

  /** The delay before the next try after `err`. */
  retryDelay(err) {
    if (err?.kind === 'auth' || err?.kind === 'notfound') {
      return TIMINGS.authRetry;
    }
    if (err?.kind === 'rate') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    return Math.min(TIMINGS.retryMax, TIMINGS.retryMin * 2 ** (this.failures - 1));
  }

  async fail(generation, err) {
    if (!this.current(generation)) {
      return;
    }
    this.online = false;
    this.reading = false;
    this.closeLive('off');
    this.timers.clearTimeout(this.liveTimer);
    this.failures += 1;
    this.lastError = err;
    const delay = this.retryDelay(err);
    if (err?.kind === 'rate') {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
    }
    if (err instanceof HubitatError) {
      this.logger.warn(`Hubitat: ${err.message} (retrying in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('Hubitat: unexpected failure', err);
    }
    await this.setStatus(false, T.failure(err));
    await this.publishAllTransports();
    this.schedule(generation, delay, () => this.open(generation));
  }

  /** A 429 on any path (command, read back, scan, test) pauses the whole integration. */
  pauseOn(err) {
    if (err?.kind !== 'rate') {
      return;
    }
    const delay = this.retryDelay(err);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
    if (this.online) {
      this.background(this.fail(this.generation, err));
    }
  }

  // --- Reading the devices ---------------------------------------------------------

  readInterval() {
    return this.liveState === 'live' ? TIMINGS.resync : this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms = this.readInterval()) {
    this.schedule(generation, ms, () => this.read(generation));
  }

  async read(generation) {
    this.reading = true;
    try {
      await this.loadAll(generation);
    } catch (err) {
      // Any failure (a 429 included: its pause then covers every path) reconnects.
      await this.fail(generation, err);
      return;
    } finally {
      if (this.current(generation)) {
        this.reading = false;
      }
    }
    if (this.current(generation) && this.online) {
      if (this.liveState === 'live' && this.now() - this.lastMessageAt > TIMINGS.liveSilence) {
        this.liveLost(generation, 'no message on the event socket for 30 minutes');
      }
      await this.connectedStatus();
      this.scheduleRead(generation);
    }
  }

  /**
   * Reads every authorized device; publishes the devices and the values. An
   * attribute a live event changed after the start of the read keeps the
   * event's value, and the units seen in events are kept.
   */
  async loadAll(generation, { force = false } = {}) {
    const since = this.eventSeq;
    const startedAt = this.now();
    const answer = await this.client.devicesAll();
    if (!this.current(generation)) {
      return;
    }
    if (!Array.isArray(answer)) {
      throw new HubitatError('format', 'the device list is not a list');
    }
    const fresh = recordsOf(answer);
    const watch = this.liveState === 'live' && this.readStartedAt >= this.liveSince;
    let missed;
    const merged = new Map();
    for (const [id, record] of fresh) {
      const known = this.records.get(id);
      if (watch && known && !missed) {
        missed = this.missedChange(known, record, since);
      }
      merged.set(id, mergeRecord(known, record, { since, keepMissing: false }));
    }
    this.records = merged;
    this.readStartedAt = startedAt;
    await this.rebuild({ force });
    for (const record of this.records.values()) {
      if (!this.guards.has(record.id)) {
        this.unconfirmed.delete(record.id);
      }
      this.applyRecord(record);
    }
    if (missed) {
      this.liveLost(generation, `a change of ${missed} came with no live event`);
    }
  }

  /** A two-state attribute the read finds changed, though no event told it: its name. */
  missedChange(known, fresh, since) {
    for (const name of WATCHED) {
      const before = known.attributes.get(name);
      const after = fresh.attributes.get(name);
      if (!before || !after || (before.at !== undefined && before.at > since)) {
        continue;
      }
      if (String(before.value) !== String(after.value)) {
        return `${known.id}:${name}`;
      }
    }
    return undefined;
  }

  /** The model from the records; published when it changed. */
  async rebuild({ force = false } = {}) {
    const model = buildModel((id) => this.idsOf(id), this.records.values(), {
      language: this.config.language,
      scale: this.config.temperatureScale,
    });
    this.model = model;
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: model.throttled,
    });
    const json = JSON.stringify(model.devices);
    if (force || json !== this.publishedDevices) {
      try {
        await this.gladys.publishDiscoveredDevices(model.devices);
        this.publishedDevices = json;
        this.logger.info(
          `${model.devices.length} devices offered in Discovery (${model.counts.devices} authorized in the Maker API)`,
        );
      } catch (err) {
        this.logger.error(`Publishing the discovered devices failed: ${err.message}`);
      }
    }
  }

  /** One record: its values to the features, its guard, its badge. */
  applyRecord(record, attrs) {
    for (const reader of this.model.readers.get(record.id) ?? []) {
      if (attrs && !reader.attrs.some((a) => attrs.includes(a))) {
        continue;
      }
      let value;
      try {
        value = reader.read(record);
      } catch (err) {
        this.warnOnce(`read:${reader.featureId}`, `${reader.featureId}: ${err.message}`);
        continue;
      }
      if (value && reader.meter) {
        this.recordIndex(reader.featureId, value);
      } else if (value) {
        this.record(reader.featureId, value);
      }
    }
    this.checkGuard(record);
    this.publishTransportOf(record.id);
  }

  // --- Energy indexes (src/guard.js) ---------------------------------------------------

  /**
   * An energy index, through the guard of its feature: a plausible value is
   * sent; while a jump or a drop is held, the last accepted value is sent
   * again (no delta for the core); 0, an invalid value or another source is
   * never sent. A feature not created yet only keeps the value read: it meets
   * a new guard when the user creates the device.
   */
  recordIndex(featureId, value) {
    this.indexesRead.set(featureId, value);
    if (!this.created.has(featureId)) {
      return;
    }
    const guard = this.indexGuardOf(featureId);
    const taken = guard.accept(value.state, this.now());
    this.trackDrop(featureId, guard);
    this.noteHold(featureId, guard);
    this.saveGuard(featureId, guard);
    if (taken) {
      this.record(featureId, { state: value.state });
    } else if (guard.held && guard.last) {
      this.record(featureId, { state: guard.last.value });
    }
  }

  /** The highest plausible power of an energy feature: a plug (switch/energy) or a meter alone. */
  maxKwOf(feature) {
    return feature?.category === DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR
      ? INDEX_MAX_KW.meter
      : INDEX_MAX_KW.plug;
  }

  /** The guard of a created energy feature, from Gladys (`last_value`) and /data. */
  indexGuardOf(featureId) {
    let guard = this.indexGuards.get(featureId);
    if (!guard) {
      const saved = this.loadState()[featureId];
      const feature = createdFeature(this.gladys.devices, featureId);
      const maxKw = this.maxKwOf(feature);
      guard = new IndexGuard(lastValueOf(feature), saved, this.now(), maxKw);
      this.indexGuards.set(featureId, guard);
      if (guard.held?.direction === 'down') {
        // Only a drop that lasted is ever written: shown at once after a restart.
        this.drops.set(featureId, { from: guard.held.from, since: -Infinity });
      }
      this.savedKeys.set(featureId, stateKeys(new IndexGuard(undefined, saved, 0, maxKw).state()));
    }
    return guard;
  }

  /**
   * A drop is shown (badge, log, /data, the action) only once it lasted
   * TIMINGS.dropShownAfter: a driver that jitters (312.41, 312.40, 312.41)
   * tells nothing. A jump is shown at once. The guard itself is not changed:
   * a young drop is held all the same (the last accepted value is sent).
   */
  trackDrop(featureId, guard) {
    const held = guard.held;
    const seen = this.drops.get(featureId);
    if (held?.direction !== 'down') {
      if (seen) {
        this.timers.clearTimeout(seen.timer);
        this.drops.delete(featureId);
      }
      return;
    }
    if (seen && seen.from === held.from) {
      return;
    }
    this.timers.clearTimeout(seen?.timer);
    const drop = { from: held.from, since: this.now() };
    drop.timer = this.timers.setTimeout(() => {
      drop.timer = undefined;
      const current = this.indexGuards.get(featureId);
      if (this.drops.get(featureId) !== drop || current?.held?.direction !== 'down') {
        return;
      }
      // Still dropped a minute later: told now.
      this.noteHold(featureId, current);
      this.saveGuard(featureId, current);
      const owner = this.ownerOfIndex(featureId);
      if (owner !== undefined) {
        this.publishTransportOf(owner);
      }
    }, TIMINGS.dropShownAfter);
    this.drops.set(featureId, drop);
  }

  /** The hold of a guard as the user sees it: a drop only once it lasted. */
  shownHold(featureId, guard) {
    const held = guard.held;
    if (!held) {
      return undefined;
    }
    if (held.direction === 'up') {
      return held;
    }
    const seen = this.drops.get(featureId);
    return seen && seen.from === held.from && this.now() - seen.since >= TIMINGS.dropShownAfter
      ? held
      : undefined;
  }

  /** A hold is logged when it is shown or changes, and its end. */
  noteHold(featureId, guard) {
    const held = this.shownHold(featureId, guard);
    const key = held ? holdKey(held).join(':') : undefined;
    if (key === this.holdLogged.get(featureId)) {
      return;
    }
    if (held) {
      this.holdLogged.set(featureId, key);
      this.logger.warn(
        `${featureId}: energy index ${held.direction === 'down' ? 'drop' : 'jump'} from ${held.from} to ${held.to} kWh held back, the last accepted value is sent again; the "Accept the held index" action takes it`,
      );
    } else if (!guard.held) {
      this.holdLogged.delete(featureId);
      this.logger.info(`${featureId}: energy index no longer held`);
    }
  }

  /** The energy indexes held and shown, of one Gladys device or all: [{ featureId, direction, from, to, threshold }]. */
  heldOf(deviceId) {
    const held = [];
    for (const [featureId, guard] of this.indexGuards) {
      if (deviceId !== undefined && !featureId.startsWith(`${deviceId}:`)) {
        continue;
      }
      const shown = this.created.has(featureId) && this.shownHold(featureId, guard);
      if (shown) {
        const { direction, from, to, threshold } = shown;
        held.push({ featureId, direction, from, to, threshold });
      }
    }
    return held;
  }

  loadState() {
    this.savedState ??= this.store.load();
    return this.savedState;
  }

  /**
   * Keeps the guard in /data, as the user sees it (a young drop is not
   * written): at once when its hold starts, changes or ends; a reference
   * that only rose at most every STATE.saveEvery (Gladys holds it too, as
   * `last_value`).
   */
  saveGuard(featureId, guard) {
    const state = { last: guard.last ?? null, held: this.shownHold(featureId, guard) ?? null };
    const keys = stateKeys(state);
    const before = this.savedKeys.get(featureId);
    if (before?.all === keys.all) {
      return;
    }
    this.savedKeys.set(featureId, keys);
    this.loadState()[featureId] = state;
    this.stateDirty = true;
    if (before?.hold !== keys.hold) {
      this.timers.clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
      this.background(this.writeState());
    } else if (this.stateTimer === undefined) {
      this.stateTimer = this.timers.setTimeout(() => {
        this.stateTimer = undefined;
        this.background(this.writeState());
      }, STATE.saveEvery);
    }
  }

  /** Writes /data, one write at a time: the guards of the created features only, bounded. */
  writeState() {
    this.stateWrite = this.stateWrite.then(async () => {
      if (!this.stateDirty) {
        return;
      }
      this.stateDirty = false;
      const data = {};
      let count = 0;
      for (const [featureId, state] of Object.entries(this.loadState())) {
        if (count >= STATE.maxEntries) {
          break;
        }
        if (this.created.has(featureId) && featureId.length <= STATE.maxKeyLength) {
          data[featureId] = state;
          count += 1;
        }
      }
      try {
        await this.store.save(data);
      } catch (err) {
        this.stateDirty = true;
        this.logger.warn(`Saving the energy index state in /data failed (${err?.code ?? 'error'})`);
      }
    });
    return this.stateWrite;
  }

  /**
   * A device just created: its energy features start a new guard (no
   * reference, nothing held from a deleted device of the same id).
   */
  async resetGuards(deviceId) {
    const owned = (id) => id.startsWith(`${deviceId}:`);
    let removed = false;
    for (const featureId of Object.keys(this.loadState())) {
      if (owned(featureId)) {
        delete this.savedState[featureId];
        removed = true;
      }
    }
    for (const featureId of [...this.drops.keys()].filter(owned)) {
      this.timers.clearTimeout(this.drops.get(featureId).timer);
    }
    for (const map of [this.indexGuards, this.savedKeys, this.holdLogged, this.drops]) {
      for (const featureId of [...map.keys()].filter(owned)) {
        map.delete(featureId);
      }
    }
    this.pendingAccept = undefined;
    if (removed) {
      this.stateDirty = true;
      await this.writeState();
    }
  }

  /**
   * The "Accept the held index" action, in two clicks. The first one only
   * lists the indexes held and the kWh at stake. A second one within
   * TIMINGS.acceptConfirm takes them, if the same holds are still there
   * (featureId:up:from:threshold for a jump, featureId:down:from for a drop,
   * whose low value moves with each reading of a reset meter) and each value
   * held now stays within what was listed: for a jump, from the `to` listed
   * up to `to` + the margin of the guard since the listing; for a drop, the
   * same (never lower than the `to` listed). Otherwise it is a first click again. Each one is
   * then taken as shown (plus what the device may draw until its next
   * value, src/guard.js), never anything else.
   */
  async acceptHeldIndex() {
    const holds = this.heldOf().sort((a, b) => (a.featureId < b.featureId ? -1 : 1));
    if (holds.length === 0) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const nameOf = (featureId) => createdFeature(this.gladys.devices, featureId)?.name ?? featureId;
    const fingerprint = holds
      .map((h) =>
        h.direction === 'down'
          ? `${h.featureId}:down:${h.from}`
          : `${h.featureId}:up:${h.from}:${h.threshold}`,
      )
      .join('|');
    const pending = this.pendingAccept;
    const now = this.now();
    if (
      !pending ||
      pending.fingerprint !== fingerprint ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at ||
      !holds.every((h) => this.withinListed(h, pending.listed.get(h.featureId), now))
    ) {
      this.pendingAccept = {
        fingerprint,
        at: now,
        listed: new Map(holds.map((h) => [h.featureId, { to: h.to, at: now }])),
      };
      return T.accept.confirm(holds.map((h) => ({ ...h, name: nameOf(h.featureId) })));
    }
    this.pendingAccept = undefined;
    const accepted = [];
    for (const { featureId } of holds) {
      const taken = this.indexGuards.get(featureId)?.acceptHeld();
      if (taken) {
        accepted.push({ featureId, name: nameOf(featureId), ...taken });
      }
    }
    for (const { featureId, direction, from, to } of accepted) {
      this.logger.info(
        `${featureId}: energy index ${direction === 'down' ? 'drop' : 'jump'} from ${from} to ${to} kWh accepted by the user`,
      );
    }
    // Taken now from the values read (the hub sends the next ones anyway).
    const owners = new Set(accepted.map(({ featureId }) => this.ownerOfIndex(featureId)));
    for (const id of owners) {
      const record = this.records.get(id);
      if (record) {
        this.applyRecord(record);
      }
    }
    return T.accept.done(accepted);
  }

  /**
   * Whether a hold, at its second click, is still what the first one
   * listed (`{ to, at }`): a jump or a drop between `to` and `to` + the
   * margin of its guard since then.
   */
  withinListed(hold, listed, now) {
    const guard = this.indexGuards.get(hold.featureId);
    if (!listed || !guard) {
      return false;
    }
    const top = listed.to + (guard.maxKw * Math.max(0, now - listed.at)) / HOUR + INDEX_SLACK_KWH;
    // Both ways a floor: a value lower than the one listed is a first click again.
    return hold.to >= listed.to && hold.to <= top;
  }

  /** The hub device id of an energy feature. */
  ownerOfIndex(featureId) {
    for (const [id, readers] of this.model.readers) {
      if (readers.some((r) => r.featureId === featureId)) {
        return id;
      }
    }
    return undefined;
  }

  /** Keeps the value, and sends it when the device exists in Gladys. */
  record(featureId, value) {
    this.lastValues.set(featureId, value);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, value);
    }
  }

  // --- Live events -----------------------------------------------------------------

  startLive(generation) {
    const ready = this.current(generation) && this.online && this.client && this.config.live;
    if (!ready || this.live || this.liveOpening === generation) {
      return;
    }
    this.liveOpening = generation;
    // A reopening by the watchdog keeps 'live' (no degraded badge) until it fails.
    if (this.liveState !== 'down' && this.liveState !== 'live') {
      this.liveState = 'connecting';
    }
    this.openLive({
      url: this.config.url,
      WebSocket: this.WebSocket,
      timers: this.timers,
      onEvent: (event) => {
        if (this.current(generation)) {
          this.onLiveEvent(generation, event);
        }
      },
      onMessage: () => {
        this.lastMessageAt = this.now();
      },
      onClose: (reason) => {
        if (this.current(generation)) {
          this.live = null;
          this.liveFailed(generation, new LiveError('closed', reason)).catch(() => {});
        }
      },
    })
      .finally(() => {
        if (this.liveOpening === generation) {
          this.liveOpening = undefined;
        }
      })
      .then(async (session) => {
        if (!this.current(generation) || !this.online) {
          session.close();
          return;
        }
        this.live = session;
        this.liveState = 'live';
        this.liveSince = this.now();
        this.lastMessageAt = this.now();
        if (this.liveFailures > 0) {
          this.logger.info(`Live events on again after ${this.liveFailures} failure(s)`);
        } else {
          this.logger.info('Live events on (hub event socket)');
        }
        this.liveFailures = 0;
        this.liveError = undefined;
        await this.connectedStatus();
        await this.publishAllTransports();
        // The changes between the last read and the socket: read once now.
        if (!this.reading) {
          this.scheduleRead(generation, 0);
        }
      })
      .catch((err) => this.liveFailed(generation, err));
  }

  /**
   * The watchdog: the socket seems deaf, open it again at once. The state
   * stays 'live' (no "down", no degraded badge) unless the reopening fails.
   */
  liveLost(generation, reason) {
    this.logger.warn(`Hubitat live events: ${reason}, opening the event socket again`);
    const session = this.live;
    this.live = null;
    session?.close();
    // No watchdog comparison until the new socket is open.
    this.liveSince = Infinity;
    this.startLive(generation);
  }

  async liveFailed(generation, err) {
    if (!this.current(generation) || !this.online) {
      return;
    }
    const wasDown = this.liveState === 'down';
    this.liveState = 'down';
    this.liveSince = Infinity;
    this.liveError = err;
    this.liveFailures += 1;
    const delay = Math.min(
      TIMINGS.liveRetryMax,
      TIMINGS.liveRetryMin * 2 ** (this.liveFailures - 1),
    );
    // A refused socket is told for its first failures, then once in a while.
    const n = this.liveFailures;
    if (n <= TIMINGS.liveWarnFirst || n % TIMINGS.liveWarnEvery === 0) {
      this.logger.warn(
        `Hubitat live events: ${err?.message ?? err} (failure ${n}; reading every ${this.config.pollInterval} s, socket again in ${Math.round(delay / 1000)} s)`,
      );
    }
    this.timers.clearTimeout(this.liveTimer);
    this.liveTimer = this.timers.setTimeout(() => {
      this.liveTimer = undefined;
      this.startLive(generation);
    }, delay);
    if (!wasDown && !this.reading) {
      this.scheduleRead(generation, this.config.pollInterval * 1000);
    }
    await this.connectedStatus();
    await this.publishAllTransports();
  }

  closeLive(state) {
    const session = this.live;
    this.live = null;
    session?.close();
    this.liveState = state;
    this.liveSince = Infinity;
  }

  /** One device event of the hub: a press, or an attribute of an authorized device. */
  onLiveEvent(generation, event) {
    const record = this.records.get(event.deviceId);
    if (!record) {
      // A device not authorized in the Maker API (the socket carries them all).
      return;
    }
    if (BUTTON_EVENTS.includes(event.name)) {
      this.press(record.id, event.name, event.value);
      return;
    }
    if (TEMPERATURES.has(event.name)) {
      this.noteScale(event.unit);
    }
    this.eventSeq += 1;
    const updated = withAttribute(record, event.name, event.value, event.unit, this.eventSeq);
    this.records.set(record.id, updated);
    if (event.name === 'numberOfButtons') {
      this.scheduleModel(generation);
      return;
    }
    this.applyRecord(updated, [event.name]);
  }

  /** The unit of a temperature event: the scale of the hub, told when it is not the option's. */
  noteScale(unit) {
    const seen = scaleOf(unit, undefined);
    if (!seen) {
      return;
    }
    this.hubScale = seen;
    const mismatch = seen !== this.config.temperatureScale;
    if (mismatch) {
      this.warnOnce(
        'scale',
        `The hub reports °${seen} but the temperature scale option is °${this.config.temperatureScale}`,
      );
    }
    if (mismatch !== this.scaleMismatch) {
      this.scaleMismatch = mismatch;
      if (this.online) {
        this.background(this.connectedStatus());
      }
    }
  }

  /** A button event: one state per press, sent even when equal to the last. */
  press(id, name, value) {
    const buttons = this.model.buttons.get(id);
    const n = Number.parseInt(String(value), 10);
    if (!buttons || !Number.isInteger(n) || n < 1 || n > buttons.count) {
      return;
    }
    const key = `${id}:${n}`;
    let state = BUTTON_STATES[name];
    if (name === 'held') {
      this.held.add(key);
    } else if (name === 'released' && this.held.delete(key)) {
      // The end of a long press.
      state = BUTTON_STATUS.LONG_CLICK_RELEASE;
    } else {
      this.held.delete(key);
    }
    const featureId = buttons.featureOf(n);
    if (this.created.has(featureId)) {
      this.publisher.pushEvent(featureId, { state });
    }
  }

  /** The model again after a burst of changes (number of buttons). */
  scheduleModel(generation) {
    this.timers.clearTimeout(this.modelTimer);
    this.modelTimer = this.timers.setTimeout(() => {
      this.modelTimer = undefined;
      if (this.current(generation) && this.online) {
        this.background(this.rebuild());
      }
    }, TIMINGS.modelDebounce);
  }

  // --- Inventory -----------------------------------------------------------------

  idsOf(id) {
    return this.gladys.externalIds('hubitat', id);
  }

  deviceIdOf(id) {
    const ids = this.idsOf(id);
    return this.model.deviceIds.has(ids.device) ? ids.device : undefined;
  }

  /** The Scan button of the Discovery tab (never during a 429 pause). */
  async rescan() {
    if (!this.online || !this.client || this.paused()) {
      await this.gladys.publishDiscoveredDevices(this.model.devices);
      return;
    }
    try {
      await this.loadAll(this.generation, { force: true });
    } catch (err) {
      this.pauseOn(err);
      throw err;
    }
  }

  // --- Transport badges ----------------------------------------------------------

  /** The badge of a device: hub reachable, the device online and confirmed, the live events on. */
  transportOf(deviceId) {
    if (!this.online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const id = this.model.deviceIds.get(deviceId);
    const record = this.records.get(id);
    if (stringAttr(record, 'healthStatus') === 'offline') {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.badge.offline };
    }
    const held = this.heldOf(deviceId);
    if (held.length > 0) {
      // An energy index held back: the user must see it to accept it (or not).
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.held(held[0]) };
    }
    if (this.unconfirmed.has(id)) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    if (this.liveState === 'down') {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.noLive(this.config.pollInterval),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  publishTransportOf(id) {
    const deviceId = this.deviceIdOf(id);
    if (deviceId) {
      this.background(this.publishTransport(deviceId));
    }
  }

  async publishTransport(deviceId) {
    if (!this.createdDevices().has(deviceId)) {
      return;
    }
    const badge = this.transportOf(deviceId);
    const key = JSON.stringify(badge);
    if (this.transports.get(deviceId) === key) {
      return;
    }
    this.transports.set(deviceId, key);
    await this.gladys.publishTransports([{ external_id: deviceId, ...badge }]);
  }

  async publishAllTransports() {
    const entries = [];
    for (const deviceId of this.createdDevices()) {
      const badge = this.transportOf(deviceId);
      const key = JSON.stringify(badge);
      if (this.transports.get(deviceId) !== key) {
        this.transports.set(deviceId, key);
        entries.push({ external_id: deviceId, ...badge });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Devices created by the user -------------------------------------------------

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** A device created by the user: its energy indexes start a new guard, its values right away. */
  async deviceCreated(device) {
    if (device?.external_id) {
      await this.resetGuards(device.external_id);
    }
    await this.deviceUpdated(device);
  }

  /** A device created or updated (new features): the values known, sent. */
  async deviceUpdated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    const meters = new Set();
    for (const readers of this.model.readers.values()) {
      for (const reader of readers) {
        if (reader.meter) {
          meters.add(reader.featureId);
        }
      }
    }
    for (const f of device?.features ?? []) {
      if (meters.has(f.external_id)) {
        // The value read (never the one sent), through the guard.
        const read = this.indexesRead.get(f.external_id);
        if (read) {
          this.recordIndex(f.external_id, read);
        }
        continue;
      }
      const value = this.lastValues.get(f.external_id);
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
      // Its guards leave /data now (writeState keeps the created features only).
      const owned = Object.keys(this.loadState()).some((id) =>
        id.startsWith(`${device.external_id}:`),
      );
      if (owned) {
        this.stateDirty = true;
        await this.writeState();
      }
    }
  }

  // --- Commands ------------------------------------------------------------------

  denied(key) {
    const err = new Error(word(T.denied[key], this.config.language));
    err.refusal = key;
    err.localized = true;
    return err;
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return run;
  }

  /** Whether the option of a guarded command is on. */
  allowed(safety) {
    if (safety === 'lock') {
      return this.config.allowLock;
    }
    if (safety === 'garage') {
      return this.config.allowGarage;
    }
    return true;
  }

  /** Refuses a guarded command whose option is off. */
  checkAllowed(writer) {
    if (!this.allowed(writer.safety)) {
      throw this.denied(writer.safety === 'lock' ? 'lockOff' : 'garageOff');
    }
  }

  /** Refuses a guarded command while the previous one is not confirmed. */
  checkNotGuarded(id) {
    const guard = this.guards.get(id);
    if (guard && this.now() < guard.until) {
      throw this.denied('busy');
    }
  }

  /**
   * The request options of a command: timeouts of what is left before
   * `deadline`, and a guard refusing to send once it is past.
   */
  commandOptions(deadline) {
    const left = (slack = 0) =>
      clamp(
        deadline + slack - this.now(),
        TIMINGS.commandTimeoutMin,
        TIMINGS.setValueDeadline + slack,
      );
    const check = () => {
      if (this.now() > deadline) {
        throw this.denied('tooLate');
      }
    };
    return {
      check,
      read: { timeout: () => left(), guard: check },
      send: { timeout: () => left(TIMINGS.commandSlack), guard: check },
    };
  }

  /**
   * A lock or a garage door, read just now: the commands to send (none when
   * already in place), the state asked for and the state before, or a refusal
   * when its state is unknown or moving.
   */
  async freshPlan(id, writer, value, options) {
    const since = this.eventSeq;
    let answer;
    try {
      answer = await this.client.device(id, options.read);
    } catch (err) {
      if (err?.refusal) {
        throw err;
      }
      this.pauseOn(err);
      this.logger.warn(`Device ${id}: state not read before a command (${err.message})`);
      throw this.denied('unknownState');
    }
    const fresh = recordOf(answer);
    if (!fresh || fresh.id !== id) {
      throw this.denied('unknownState');
    }
    const record = mergeRecord(this.records.get(id), fresh, { since });
    this.records.set(id, record);
    this.unconfirmed.delete(id);
    this.applyRecord(record);
    const state = guardedState(record, writer.safety);
    const v = Number(value);
    if (writer.safety === 'garage' && v === 0) {
      // Stop (refused without a stop command): only a moving door has something to stop.
      const calls = writer.write(0, record);
      return { calls: state === 'moving' ? calls : [] };
    }
    if (state === undefined || state === 'moving') {
      throw this.denied(writer.safety === 'lock' ? 'unknownState' : 'moving');
    }
    const expected = v > 0 ? 1 : 0;
    if (state === expected) {
      return { calls: [] };
    }
    return { calls: writer.write(v, record), expected, start: state };
  }

  /** After a guarded command: no other one until the device reports `expected`. */
  setGuard(id, safety, expected, start) {
    const previous = this.guards.get(id);
    this.timers.clearTimeout(previous?.timer);
    const span = TIMINGS.guard[safety];
    const guard = { safety, expected, start, sawMoving: false, until: this.now() + span };
    guard.timer = this.timers.setTimeout(() => {
      if (this.guards.get(id) === guard) {
        this.guards.delete(id);
        // Never confirmed in time: told on the badge until a read shows a state.
        this.logger.warn(`Device ${id}: the state asked for was not reported in time`);
        this.unconfirmed.add(id);
        this.publishTransportOf(id);
      }
    }, span);
    this.guards.set(id, guard);
    // An event that came during the request may already report the state asked for.
    const record = this.records.get(id);
    if (record) {
      this.checkGuard(record);
    }
    for (const delay of TIMINGS.guardReadBacks[safety]) {
      this.readBack(id, delay, { guarded: true });
    }
  }

  /**
   * A new state of a guarded device: a move is noted; the guard is lifted only
   * on the state asked for, and on the state it started from only after a
   * move was seen (a delayed report never lifts it); never on an unknown state.
   */
  checkGuard(record) {
    const guard = this.guards.get(record.id);
    if (!guard) {
      return;
    }
    const state = guardedState(record, guard.safety);
    if (state === 'moving') {
      guard.sawMoving = true;
      return;
    }
    if (state === guard.expected && (state !== guard.start || guard.sawMoving)) {
      this.timers.clearTimeout(guard.timer);
      this.guards.delete(record.id);
      this.unconfirmed.delete(record.id);
    }
  }

  /** Reads one device back later (no live events, or a guarded device). */
  readBack(id, delay, { guarded = false } = {}) {
    const generation = this.generation;
    const timer = this.timers.setTimeout(async () => {
      this.readBackTimers.delete(timer);
      if (!this.current(generation) || !this.online || !this.client || this.paused()) {
        return;
      }
      const since = this.eventSeq;
      try {
        const fresh = recordOf(await this.client.device(id));
        if (fresh && fresh.id === id && this.current(generation)) {
          const record = mergeRecord(this.records.get(id), fresh, { since });
          this.records.set(id, record);
          this.unconfirmed.delete(id);
          this.applyRecord(record);
        }
      } catch (err) {
        this.pauseOn(err);
        this.logger.warn(`Read back of device ${id} failed: ${err.message}`);
        if (guarded && this.current(generation)) {
          this.unconfirmed.add(id);
          this.publishTransportOf(id);
        }
      }
    }, delay);
    this.readBackTimers.add(timer);
  }

  /** Gladys command (acked within 5 s): sent within 3.5 s of its arrival, or refused. */
  async setValue(_device, feature, value) {
    const deadline = this.now() + TIMINGS.setValueDeadline;
    const featureId = feature?.external_id;
    try {
      const writer = this.model.writers.get(featureId);
      const id = this.model.owners.get(featureId);
      if (!writer || id === undefined) {
        throw this.denied('notCommand');
      }
      this.checkAllowed(writer);
      if (this.paused()) {
        throw this.denied('paused');
      }
      if (!this.client || !this.online) {
        throw this.denied('notConnected');
      }
      // Stopping a moving garage door stays possible while it is guarded.
      const stop = writer.safety === 'garage' && Number(value) === 0;
      if (writer.safety && !stop) {
        this.checkNotGuarded(id);
      }
      await this.serialized(id, async () => {
        // The options and the guard may have changed while the command waited.
        this.checkAllowed(writer);
        const client = this.client;
        if (!client || !this.online) {
          throw this.denied('notConnected');
        }
        const options = this.commandOptions(deadline);
        options.check();
        let plan;
        try {
          if (writer.safety) {
            if (!stop) {
              this.checkNotGuarded(id);
            }
            plan = await this.freshPlan(id, writer, value, options);
          } else {
            const record = this.records.get(id);
            if (writer.temperature) {
              this.checkScale(record, writer.temperature);
            }
            plan = { calls: writer.write(value, record) };
          }
        } catch (err) {
          // A refusal of the mapping (src/mapping.js) gets its text in the user's language.
          if (err?.refusal && !err.localized) {
            throw this.denied(T.denied[err.refusal] ? err.refusal : 'badValue');
          }
          throw err;
        }
        // Requests that may have reached the device (a "too late" refusal never left).
        let sent = 0;
        try {
          for (const call of plan.calls) {
            // The option is checked once more just before the request leaves.
            this.checkAllowed(writer);
            try {
              await client.command(id, call.command, call.args, options.send);
              sent += 1;
            } catch (err) {
              if (err?.refusal !== 'tooLate') {
                sent += 1;
              }
              throw err;
            }
          }
        } finally {
          if (sent > 0) {
            if (writer.safety && plan.expected !== undefined) {
              // Set after the request, sent or failed (it may have reached the device).
              this.setGuard(id, writer.safety, plan.expected, plan.start);
            } else if (writer.safety) {
              this.readBack(id, TIMINGS.guardReadBacks[writer.safety][0], { guarded: true });
            }
            if (this.liveState !== 'live') {
              this.readBack(id, TIMINGS.commandEcho);
            }
          }
        }
        this.logger.debug(`${plan.calls.length} Hubitat command(s) for ${featureId}`);
      });
    } catch (err) {
      // Gladys shows the value asked for: send the known one again.
      this.gladys.forgetPublishedStates?.(featureId);
      const known = this.lastValues.get(featureId);
      if (known && this.created.has(featureId)) {
        this.publisher.push(featureId, known);
      }
      this.pauseOn(err);
      throw err;
    }
  }

  /**
   * A setpoint is sent in the scale of the attribute's unit, else the one the
   * hub's events gave, else the option; refused when the hub's events
   * contradict the option, or when the current setpoint is unknown or outside
   * the band of that scale (disjoint bands: °C only up to 35, °F only from
   * 39), so a °F hub configured in °C (or the reverse) is caught even without
   * live events.
   */
  checkScale(record, attr) {
    if (this.hubScale && this.hubScale !== this.config.temperatureScale) {
      throw this.denied('scaleUnknown');
    }
    const scale =
      scaleOf(record?.attributes.get(attr)?.unit, undefined) ??
      this.hubScale ??
      this.config.temperatureScale;
    const current = numberAttr(record, attr);
    if (current === undefined || (scale === 'C' ? current > 35 : current < 39)) {
      this.warnOnce(
        `implausible:${record.id}`,
        `Device ${record.id}: ${attr} ${current} in °${scale}?`,
      );
      throw this.denied('scaleUnknown');
    }
  }

  // --- Configuration screen button ---------------------------------------------------

  /** Reads the Maker API with the saved configuration, tries the event socket, counts. */
  async testConnection() {
    const config = this.config;
    if (config.error) {
      return T.configError(config.error);
    }
    if (this.paused()) {
      // A 429 pause covers the test too.
      return T.failure({ kind: 'rate' });
    }
    const client = this.connect({ url: config.url, appId: config.appId, token: config.token });
    try {
      const answer = await client.devicesAll({ timeout: TIMINGS.testTimeout });
      if (!Array.isArray(answer)) {
        throw new HubitatError('format', 'the device list is not a list');
      }
      const records = recordsOf(answer);
      const model = buildModel((id) => this.idsOf(id), records.values(), {
        language: config.language,
        scale: config.temperatureScale,
      });
      let live;
      if (config.live) {
        try {
          const session = await this.openLive({
            url: config.url,
            WebSocket: this.WebSocket,
            timers: this.timers,
          });
          session.close();
          live = { ok: true };
        } catch (err) {
          live = { ok: false, error: err };
        }
      }
      return T.test.ok({
        url: config.url,
        appId: config.appId,
        total: records.size,
        devices: model.devices.length,
        empty: model.counts.empty,
        live,
      });
    } catch (err) {
      this.pauseOn(err);
      if (!(err instanceof HubitatError)) {
        this.logger.error('Connection test failed', err);
      }
      return T.failure(err);
    } finally {
      client.close?.();
    }
  }
}
