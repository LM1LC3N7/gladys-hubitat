// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): per
// energy feature, the reference of the billed index and the value held back
// (src/guard.js), so that a restart never forgets a jump or a drop the user
// has not accepted. A small JSON file, written through a temporary file and a
// rename. Read back bounded (size, number of entries, key length) and checked
// (only objects; the guard validates each value). Failures are logged by the
// caller, never fatal.
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { STATE, STATE_FILE } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The entries of a state read back, bounded and checked: `{ featureId: { last, held } }`. */
export function boundedState(data) {
  const out = {};
  if (!isObject(data)) {
    return out;
  }
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (count >= STATE.maxEntries) {
      break;
    }
    if (key.length === 0 || key.length > STATE.maxKeyLength || !isObject(value)) {
      continue;
    }
    out[key] = {
      last: isObject(value.last) ? { value: value.last.value, at: value.last.at } : null,
      held: isObject(value.held)
        ? {
            direction: value.held.direction,
            from: value.held.from,
            to: value.held.to,
            threshold: value.held.threshold,
            at: value.held.at,
          }
        : null,
    };
    count += 1;
  }
  return out;
}

export function createFileStore(file = STATE_FILE) {
  return {
    load() {
      try {
        if (statSync(file).size > STATE.maxBytes) {
          return {};
        }
        return boundedState(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return {};
      }
    },
    async save(data) {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data), 'utf8');
      await rename(tmp, file);
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => boundedState(structuredClone(data)),
    async save(next) {
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
