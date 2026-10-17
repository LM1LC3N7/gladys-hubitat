// -----------------------------------------------------------------------------
// The Hubitat records -> Gladys devices and routing tables (pure).
//
// One Gladys device per Hubitat device authorized in the Maker API. External ids:
//   device  ext:<selector>:hubitat:<hub device id>
//   feature <device>:<key>                                (src/mapping.js)
// The device id of the hub never changes while the device is paired (it is
// the same whatever the Maker API instance): the external ids stay stable.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';
import { mapDevice } from './mapping.js';

/** Names repeat from room to room ("Ceiling light"): the room is part of the name. */
export function deviceName(record) {
  const name = (record.label || record.name || `Hubitat ${record.id}`).trim();
  return (record.room ? `${name} (${record.room})` : name).slice(0, 100);
}

const paramsOf = (record) =>
  [
    { name: 'HUBITAT_DEVICE_ID', value: record.id },
    { name: 'HUBITAT_ROOM', value: record.room },
    { name: 'HUBITAT_DRIVER', value: record.type || record.name },
  ]
    .filter((p) => p.value !== undefined && p.value !== null && String(p.value) !== '')
    .map((p) => ({ name: p.name, value: String(p.value).slice(0, 255) }));

export function emptyModel() {
  return {
    devices: [],
    /** hub device id -> [{ featureId, attrs, read }] */
    readers: new Map(),
    /** hub device id -> { count, featureOf(n) } for the button presses */
    buttons: new Map(),
    /** feature id -> { write, safety? } */
    writers: new Map(),
    /** feature id -> hub device id */
    owners: new Map(),
    throttled: new Set(),
    /** Gladys device id -> hub device id */
    deviceIds: new Map(),
    /** devices read, left out because nothing maps or over the limit; capabilities left out */
    counts: { devices: 0, empty: 0, overflow: 0, skipped: 0 },
  };
}

/**
 * @param {(id: string) => { device: string, feature: (key: string) => string }} idsOf
 *   the external ids of one device (gladys.externalIds('hubitat', id))
 * @param {Iterable<object>} records see src/records.js
 * @param {{ language?: 'fr'|'en', scale?: 'C'|'F' }} [options]
 */
export function buildModel(idsOf, records, options = {}) {
  const model = emptyModel();
  for (const record of records) {
    model.counts.devices += 1;
    const mapped = mapDevice(record, options);
    model.counts.skipped += mapped.skipped.length;
    if (mapped.features.length === 0) {
      model.counts.empty += 1;
      continue;
    }
    if (model.devices.length >= LIMITS.devices) {
      model.counts.overflow += 1;
      continue;
    }
    const ids = idsOf(record.id);
    model.devices.push({
      name: deviceName(record),
      external_id: ids.device,
      should_poll: false,
      params: paramsOf(record),
      features: mapped.features.map(({ key, ...feature }) => ({
        ...feature,
        external_id: ids.feature(key),
      })),
    });
    model.deviceIds.set(ids.device, record.id);
    model.readers.set(
      record.id,
      mapped.readers.map(({ key, attrs, read }) => ({ featureId: ids.feature(key), attrs, read })),
    );
    if (mapped.buttons > 0) {
      model.buttons.set(record.id, {
        count: mapped.buttons,
        featureOf: (n) => ids.feature(`button_${n}`),
      });
    }
    for (const [key, writer] of Object.entries(mapped.writers)) {
      model.writers.set(ids.feature(key), writer);
      model.owners.set(ids.feature(key), record.id);
    }
    for (const key of mapped.throttled) {
      model.throttled.add(ids.feature(key));
    }
  }
  return model;
}
