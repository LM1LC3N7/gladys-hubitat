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
// background. On a failure of the Maker API, reconnect with a growing delay.
//
// Commands: one at a time per device, sent within 3.5 s of their arrival or
// refused; locks and garage doors only when the user allowed them, on a state
// read just before. No HSM or mode command exists in this integration.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { BUTTON_EVENTS, TIMINGS } from './constants.js';
import { buildModel, emptyModel } from './devices.js';
import { LiveError, openEventSocket } from './eventsocket.js';
import { HubitatError, createClient } from './hubitat.js';
import { T, word } from './i18n.js';
import { BUTTON_STATES } from './mapping.js';
import { StatePublisher } from './publisher.js';
import { mergeRecord, recordOf, recordsOf, stringAttr, withAttribute } from './records.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** The states a lock or a garage door must be in before Gladys acts on it. */
const LOCK_KNOWN = { locked: 1, unlocked: 0, 'unlocked with timeout': 0 };
const DOOR_KNOWN = { open: 1, closed: 0 };

export class HubitatApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hubitat' }),
    connect = createClient,
    live = openEventSocket,
    WebSocket = globalThis.WebSocket,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
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
    this.online = false;
    /** the live socket, and its state: off | connecting | live | down */
    this.live = null;
    this.liveState = 'off';
    this.liveError = undefined;
    this.liveFailures = 0;
    this.liveOpening = undefined;
    this.running = false;
    /** feature id -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** device id -> last badge published (JSON) */
    this.transports = new Map();
    /** hub device id -> the tail of its command chain */
    this.chains = new Map();
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
    await this.setStatus(false, T.connecting);
    await this.open(generation);
  }

  /** The configuration changed: start again with it. */
  async configUpdated(raw = {}) {
    this.logger.info('Configuration updated: reconnecting to the Hubitat hub');
    await this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    for (const timer of [this.timer, this.modelTimer, this.liveTimer, ...this.readBackTimers]) {
      this.timers.clearTimeout(timer);
    }
    this.readBackTimers.clear();
    this.timer = undefined;
    this.modelTimer = undefined;
    this.liveTimer = undefined;
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
    await this.setStatus(
      true,
      T.connected(
        this.model.devices.length,
        this.liveState,
        this.liveError,
        this.config.pollInterval,
      ),
    );
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
      await this.loadAll(generation, { initial: true });
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
    if (err instanceof HubitatError) {
      this.logger.warn(`Hubitat: ${err.message} (retrying in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('Hubitat: unexpected failure', err);
    }
    await this.setStatus(false, T.failure(err));
    await this.publishAllTransports();
    this.schedule(generation, delay, () => this.open(generation));
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
      await this.connectedStatus();
      this.scheduleRead(generation);
    }
  }

  /** Reads every authorized device; publishes the devices and the values. */
  async loadAll(generation, { force = false } = {}) {
    const answer = await this.client.devicesAll();
    if (!this.current(generation)) {
      return;
    }
    if (!Array.isArray(answer)) {
      throw new HubitatError('format', 'the device list is not a list');
    }
    this.records = recordsOf(answer);
    await this.rebuild({ force });
    for (const record of this.records.values()) {
      this.applyRecord(record);
    }
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

  /** One record: its values to the features, its badge. */
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
      if (value) {
        this.record(reader.featureId, value);
      }
    }
    this.publishTransportOf(record.id);
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
    this.liveState = this.liveState === 'down' ? 'down' : 'connecting';
    this.openLive({
      url: this.config.url,
      WebSocket: this.WebSocket,
      timers: this.timers,
      onEvent: (event) => {
        if (this.current(generation)) {
          this.onLiveEvent(generation, event);
        }
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
        this.liveFailures = 0;
        this.liveError = undefined;
        this.logger.info('Live events on (hub event socket)');
        await this.connectedStatus();
        await this.publishAllTransports();
        // The changes between the last read and the socket: read once now.
        if (!this.reading) {
          this.scheduleRead(generation, 0);
        }
      })
      .catch((err) => this.liveFailed(generation, err));
  }

  async liveFailed(generation, err) {
    if (!this.current(generation) || !this.online) {
      return;
    }
    const wasDown = this.liveState === 'down';
    this.liveState = 'down';
    this.liveError = err;
    this.liveFailures += 1;
    const delay = Math.min(
      TIMINGS.liveRetryMax,
      TIMINGS.liveRetryMin * 2 ** (this.liveFailures - 1),
    );
    this.logger.warn(
      `Hubitat live events: ${err?.message ?? err} (reading every ${this.config.pollInterval} s, socket again in ${Math.round(delay / 1000)} s)`,
    );
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
    const updated = withAttribute(record, event.name, event.value, event.unit);
    this.records.set(record.id, updated);
    if (event.name === 'numberOfButtons') {
      this.scheduleModel(generation);
      return;
    }
    this.applyRecord(updated, [event.name]);
  }

  /** A button event: one state per press, sent even when equal to the last. */
  press(id, name, value) {
    const buttons = this.model.buttons.get(id);
    const n = Number.parseInt(String(value), 10);
    if (!buttons || !Number.isInteger(n) || n < 1 || n > buttons.count) {
      return;
    }
    const featureId = buttons.featureOf(n);
    if (this.created.has(featureId)) {
      this.publisher.pushEvent(featureId, { state: BUTTON_STATES[name] });
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

  /** The Scan button of the Discovery tab. */
  async rescan() {
    if (!this.online || !this.client) {
      await this.gladys.publishDiscoveredDevices(this.model.devices);
      return;
    }
    await this.loadAll(this.generation, { force: true });
  }

  // --- Transport badges ----------------------------------------------------------

  /** The badge of a device: hub reachable, the device online, the live events on. */
  transportOf(deviceId) {
    if (!this.online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const record = this.records.get(this.model.deviceIds.get(deviceId));
    if (stringAttr(record, 'healthStatus') === 'offline') {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.badge.offline };
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

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const f of device?.features ?? []) {
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

  /** A 429 on any path (command, read back) pauses the whole integration. */
  pauseOn(err) {
    if (err?.kind === 'rate' && this.online) {
      this.background(this.fail(this.generation, err));
    }
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
   * already in place), or a refusal when its state is unknown or moving.
   */
  async freshPlan(id, writer, value, options) {
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
    const record = mergeRecord(this.records.get(id), fresh);
    this.records.set(id, record);
    this.applyRecord(record);
    const wanted = Number(value) > 0 ? 1 : 0;
    const known = writer.safety === 'lock' ? LOCK_KNOWN : DOOR_KNOWN;
    const state = stringAttr(record, writer.safety === 'lock' ? 'lock' : 'door');
    if (state === undefined || !Object.hasOwn(known, state)) {
      throw this.denied(writer.safety === 'lock' ? 'unknownState' : 'moving');
    }
    return known[state] === wanted ? [] : writer.write(wanted, record);
  }

  /** Reads one device back later (no live events, or a slow motor). */
  readBack(id, delay) {
    const generation = this.generation;
    const timer = this.timers.setTimeout(async () => {
      this.readBackTimers.delete(timer);
      if (!this.current(generation) || !this.online || !this.client) {
        return;
      }
      try {
        const fresh = recordOf(await this.client.device(id));
        if (fresh && fresh.id === id && this.current(generation)) {
          const record = mergeRecord(this.records.get(id), fresh);
          this.records.set(id, record);
          this.applyRecord(record);
        }
      } catch (err) {
        this.pauseOn(err);
        this.logger.warn(`Read back of device ${id} failed: ${err.message}`);
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
      if (!this.allowed(writer.safety)) {
        throw this.denied(writer.safety === 'lock' ? 'lockOff' : 'garageOff');
      }
      if (!this.client || !this.online) {
        throw this.denied('notConnected');
      }
      await this.serialized(id, async () => {
        // The options may have changed while the command waited for its turn.
        if (!this.allowed(writer.safety)) {
          throw this.denied(writer.safety === 'lock' ? 'lockOff' : 'garageOff');
        }
        const client = this.client;
        if (!client || !this.online) {
          throw this.denied('notConnected');
        }
        const options = this.commandOptions(deadline);
        options.check();
        let calls;
        try {
          calls = writer.safety
            ? await this.freshPlan(id, writer, value, options)
            : writer.write(value, this.records.get(id));
        } catch (err) {
          // A refusal of the mapping (src/mapping.js) gets its text in the user's language.
          if (err?.refusal && !err.localized) {
            throw this.denied(T.denied[err.refusal] ? err.refusal : 'badValue');
          }
          throw err;
        }
        try {
          for (const call of calls) {
            await client.command(id, call.command, call.args, options.send);
          }
        } finally {
          if (calls.length > 0) {
            if (this.liveState !== 'live') {
              this.readBack(id, TIMINGS.commandEcho);
            }
            if (writer.safety) {
              this.readBack(id, TIMINGS.slowReadBack);
            }
          }
        }
        this.logger.debug(`${calls.length} Hubitat command(s) for ${featureId}`);
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

  // --- Configuration screen button ---------------------------------------------------

  /** Reads the Maker API with the saved configuration, tries the event socket, counts. */
  async testConnection() {
    const config = this.config;
    if (config.error) {
      return T.configError(config.error);
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
      if (!(err instanceof HubitatError)) {
        this.logger.error('Connection test failed', err);
      }
      return T.failure(err);
    } finally {
      client.close?.();
    }
  }
}
