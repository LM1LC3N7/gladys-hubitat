// -----------------------------------------------------------------------------
// The energy index guard (src/guard.js) and the /data store (src/store.js).
// The guard tests are those of gladys-p1-monitor (test/model.test.js), whose
// IndexGuard is reused unchanged but for the highest plausible power, a
// parameter here (10 kW for a plug, 25 kW for a meter alone, the default).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INDEX_MAX_KW, STATE } from '../src/constants.js';
import { IndexGuard } from '../src/guard.js';
import { boundedState, createFileStore, createMemoryStore } from '../src/store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('index guard: never 0, a normal rise goes through', () => {
  const guard = new IndexGuard();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(new IndexGuard().accept(-1, 0), false);
  assert.equal(new IndexGuard().accept(NaN, 0), false);
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  const back = new IndexGuard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  back.acceptHeld();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = new IndexGuard({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 2.5,
    to: 12345.5,
    threshold: 12345,
    at: 200 * 60 * MINUTE,
  });
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is billed', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  // A drop to 10 kWh, for a week: held all along.
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  // Back to the real value: it goes through, the hold ends; the reference
  // never went down, so no rise of 50,000 kWh is ever billed.
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  guard.acceptHeld();
  // The core skips the negative delta: nothing billed.
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.01, at: 2 * MINUTE });
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  // Back to the old value after the acceptance: a jump, held.
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: an acceptance of a drop never takes a jump', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(10, MINUTE);
  guard.acceptHeld();
  assert.equal(guard.accept(90_000, 2 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
  assert.equal(guard.accept(90_000, 3 * MINUTE), false);
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  // 3 hours of the same value, read every minute.
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 }, 'the date of the value is kept');
  // +4 kWh after 3 hours: 1.3 kW on average, plausible.
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = new IndexGuard({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  // A newer value in Gladys than in /data wins; the same value keeps its oldest date.
  assert.deepEqual(new IndexGuard({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(new IndexGuard({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
  assert.deepEqual(
    new IndexGuard({ value: 1000, at: -50 }, { last: { value: 1000, at: 10 } }).last,
    { value: 1000, at: -50 },
  );
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  // 5000 is not what the user saw: held again, nothing taken, acceptance dropped.
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.accepted, undefined);
  assert.equal(guard.accept(5000.1, 3 * MINUTE), false, 'still held');
  // The value shown, plus what the device may draw meanwhile: taken.
  const fair = new IndexGuard({ value: 1000, at: 0 });
  fair.accept(1005, MINUTE);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 2 * MINUTE), true);
  // Below the value shown: not the jump accepted either.
  const below = new IndexGuard({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  // A drop: at most the value shown plus the margin.
  const drop = new IndexGuard({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  drop.accept(10, 3 * MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(10.2, 4 * MINUTE), true);
  assert.equal(new IndexGuard({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});

test('index guard: a value held read back from /data is dated at its loading', () => {
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  // Loaded 5 days later: an acceptance covers 1005 plus the margin since the load only.
  const guard = new IndexGuard(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
  assert.equal(guard.held.to, 5000);
  const fair = new IndexGuard(undefined, saved, 5 * DAY);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 5 * DAY + MINUTE), true);
});

test('index guard: under a held jump, an old reference never lets a big rise through', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(15_000, MINUTE), false);
  // Still held 30 days later: the reference is now old, its margin alone
  // would cover 18,000 kWh (25 kW).
  assert.equal(guard.accept(15_000, 30 * DAY), false);
  assert.equal(guard.held.threshold, 15_000);
  // 14,000, under the jump, read a minute later: held in its turn, 0 kWh taken.
  assert.equal(guard.accept(14_000, 30 * DAY + MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 14_000);
  assert.equal(guard.held.from, 1000);
  // A value back near the reference still ends the hold.
  assert.equal(guard.accept(1000.2, 30 * DAY + 2 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: the highest plausible power is a parameter, 25 kW (a meter) by default', () => {
  assert.deepEqual(INDEX_MAX_KW, { plug: 10, meter: 25 });
  assert.equal(new IndexGuard().maxKw, 25);
  // An oven at 3.6 kW for an hour: plausible.
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(103.6, HOUR), true);
  // 25 kWh in an hour (+ the 0.5 kWh slack): the edge, taken; more, held.
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(125.5, HOUR), true);
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(125.6, HOUR), false);
  // The same rise with 100 kW given: taken.
  assert.equal(new IndexGuard({ value: 100, at: 0 }, undefined, 0, 100).accept(180, HOUR), true);
  // The acceptance is bounded by the same parameter.
  const big = new IndexGuard({ value: 100, at: 0 }, undefined, 0, 100);
  big.accept(5000, MINUTE);
  big.acceptHeld();
  assert.equal(big.accept(5000 + 100 + 0.5, MINUTE + HOUR), true);
});

// --- The /data store ---------------------------------------------------------------

test('the /data store: written through a temporary file, read back, empty when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hubitat-'));
  try {
    const store = createFileStore(join(dir, 'state.json'));
    assert.deepEqual({ ...store.load() }, {});
    const state = { 'a:energy': { last: { value: 1, at: 2 }, held: null } };
    await store.save(state);
    assert.deepEqual({ ...store.load() }, state);
    assert.deepEqual({ ...createFileStore(join(dir, 'missing', 'x.json')).load() }, {});
    // Not JSON, a list, too big: nothing read back.
    const bad = join(dir, 'bad.json');
    for (const text of ['{', '[1,2]', 'null', JSON.stringify({ x: 'y'.repeat(STATE.maxBytes) })]) {
      await writeFile(bad, text, 'utf8');
      assert.deepEqual({ ...createFileStore(bad).load() }, {}, text.slice(0, 10));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the /data store: bounded and checked when read back', () => {
  const many = {};
  for (let i = 0; i < STATE.maxEntries + 10; i += 1) {
    many[`f${i}`] = { last: { value: i + 1, at: 0 }, held: null };
  }
  assert.equal(Object.keys(boundedState(many)).length, STATE.maxEntries);
  const checked = boundedState({
    ok: {
      last: { value: 5, at: 1, extra: 'dropped' },
      held: { direction: 'up', from: 5, to: 9, threshold: 9, at: 2, x: 1 },
    },
    notObject: 'x',
    list: [],
    [`${'k'.repeat(STATE.maxKeyLength + 1)}`]: { last: null },
    bad: { last: 'x', held: 3 },
  });
  assert.deepEqual(Object.keys(checked), ['ok', 'bad']);
  assert.deepEqual(checked.ok, {
    last: { value: 5, at: 1 },
    held: { direction: 'up', from: 5, to: 9, threshold: 9, at: 2 },
  });
  assert.deepEqual(checked.bad, { last: null, held: null });
  // The guard validates the values themselves: an invalid entry gives no reference.
  const guard = new IndexGuard(undefined, {
    last: { value: 'x', at: 1 },
    held: { direction: 'x' },
  });
  assert.equal(guard.last, undefined);
  assert.equal(guard.held, undefined);
  const memory = createMemoryStore({ a: { last: { value: 1, at: 0 }, held: null }, b: 7 });
  assert.deepEqual(Object.keys(memory.load()), ['a']);
});

test('index guard: maxKw is checked (a positive, finite power in kW)', () => {
  for (const bad of [0, -1, NaN, Infinity, '10', null, 1001]) {
    assert.throws(() => new IndexGuard(undefined, undefined, 0, bad), RangeError, String(bad));
  }
  assert.equal(new IndexGuard(undefined, undefined, 0, 10).maxKw, 10);
  // A plug at 10 kW: +15 kWh in an hour is held, +10 is taken.
  assert.equal(new IndexGuard({ value: 100, at: 0 }, undefined, 0, 10).accept(115, HOUR), false);
  assert.equal(new IndexGuard({ value: 100, at: 0 }, undefined, 0, 10).accept(110, HOUR), true);
});

test('the /data store: no prototype, a "__proto__" key of the file dropped', () => {
  const state = boundedState(
    JSON.parse(
      '{"__proto__":{"last":{"value":5,"at":1},"held":null},"a":{"last":{"value":1,"at":1},"held":null}}',
    ),
  );
  assert.equal(Object.getPrototypeOf(state), null);
  assert.deepEqual(Object.keys(state), ['a']);
  assert.equal({}.last, undefined, 'Object.prototype untouched');
});
