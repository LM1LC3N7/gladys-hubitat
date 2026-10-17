// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The hub relays fast devices (a power meter every second, a whole multi-
// sensor at once). The publisher keeps the LAST value of each
// feature, sends the pending ones every second within a per-minute budget,
// skips the unchanged ones (publishChangedStates) and spaces the measurements
// of a same feature by the configured interval. Button presses are queued
// apart and all sent (publishStates): two presses in a row are two events.
// Binary sensors and actuators are never throttled, only budgeted.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

/** Presses kept while Gladys is unreachable or the budget is spent. */
const MAX_QUEUED_EVENTS = 500;

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    /** Button presses: every one counts, even twice the same value in a row. */
    this.events = [];
    /** featureId -> last send time */
    this.lastSent = new Map();
    /** send times of the last minute */
    this.window = [];
    this.interval = 0;
    this.throttled = new Set();
    this.timer = undefined;
    this.flushing = undefined;
  }

  configure({ intervalSeconds, throttled }) {
    this.interval = intervalSeconds * 1000;
    this.throttled = throttled ?? new Set();
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /**
   * A press of a button: never merged with the previous one nor skipped as
   * unchanged (a second "click" is a new press, not a repeated value).
   */
  pushEvent(featureId, value) {
    this.events.push({ device_feature_external_id: featureId, ...value });
    if (this.events.length > MAX_QUEUED_EVENTS) {
      this.events.shift();
    }
  }

  /** Forget a feature (deleted device): its pending value is dropped. */
  forget(featureIdPrefix) {
    const owned = (id) => id === featureIdPrefix || id.startsWith(`${featureIdPrefix}:`);
    this.events = this.events.filter((e) => !owned(e.device_feature_external_id));
    for (const map of [this.pending, this.lastSent]) {
      for (const key of map.keys()) {
        if (key === featureIdPrefix || key.startsWith(`${featureIdPrefix}:`)) {
          map.delete(key);
        }
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    let sent = 0;
    if (room > 0 && this.events.length > 0) {
      // publishStates, not publishChangedStates: equal values are distinct presses.
      const events = this.events.splice(0, Math.min(room, 100));
      try {
        await this.gladys.publishStates(events);
      } catch (err) {
        this.events.unshift(...events);
        throw err;
      }
      for (let i = 0; i < events.length; i += 1) {
        this.window.push(now);
      }
      room -= events.length;
      sent += events.length;
    }
    if (room <= 0 || this.pending.size === 0) {
      return sent;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      const last = this.lastSent.get(featureId);
      if (this.throttled.has(featureId) && last !== undefined && now - last < this.interval) {
        continue;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return sent;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (const entry of batch) {
        this.lastSent.set(entry.device_feature_external_id, now);
      }
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
      return sent + (result?.count ?? batch.length);
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const entry of batch) {
        const { device_feature_external_id: id, ...value } = entry;
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
