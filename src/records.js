// -----------------------------------------------------------------------------
// Hubitat device answers -> one record shape (pure).
//
// The Maker API answers in two shapes (Hubitat documentation, and the answers
// read by jason0x43/hacs-hubitat):
//   GET /devices/all   [{ id, name, label, type, room, capabilities: [string],
//                         attributes: { name: value }, commands: [string] }]
//   GET /devices/<id>  { id, name, label, type, room,
//                         capabilities: [string | { attributes }],
//                         attributes: [{ name, currentValue, dataType, values }],
//                         commands: [string | { command }] }
// A record is { id, name, label, type, room, capabilities: Set, commands: Set,
// attributes: Map(name -> { value, unit, values }) }. Records are replaced,
// never mutated: `withAttribute` returns a new one.
// -----------------------------------------------------------------------------

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** An attribute value: numbers stay numbers, the rest a string (null when absent). */
function valueOf(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  return String(raw);
}

function attributesOf(raw) {
  const attributes = new Map();
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && typeof a.name === 'string' && !attributes.has(a.name)) {
        attributes.set(a.name, {
          value: valueOf(a.currentValue ?? a.value),
          unit: typeof a.unit === 'string' ? a.unit : undefined,
          values: Array.isArray(a.values) ? a.values.map(String) : undefined,
        });
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      attributes.set(name, { value: valueOf(value), unit: undefined, values: undefined });
    }
  }
  return attributes;
}

function namesOf(raw, field) {
  const names = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry === 'string') {
      names.add(entry);
    } else if (entry && typeof entry[field] === 'string') {
      names.add(entry[field]);
    }
  }
  return names;
}

/** One device answer -> a record, or undefined when it has no id. */
export function recordOf(raw) {
  const id = text(raw?.id);
  if (!/^\d{1,12}$/.test(id) && !/^[\w-]{1,64}$/.test(id)) {
    return undefined;
  }
  return {
    id,
    name: text(raw.name),
    label: text(raw.label),
    type: text(raw.type),
    room: text(raw.room),
    capabilities: namesOf(raw.capabilities, 'name'),
    commands: namesOf(raw.commands, 'command'),
    attributes: attributesOf(raw.attributes),
  };
}

/** A list answer -> records (by id, the first wins). */
export function recordsOf(answer) {
  const records = new Map();
  for (const raw of Array.isArray(answer) ? answer : []) {
    const record = recordOf(raw);
    if (record && !records.has(record.id)) {
      records.set(record.id, record);
    }
  }
  return records;
}

/**
 * A record read later (GET /devices/<id>) merged over the one known: the new
 * attributes win; capabilities and commands are kept when the new answer
 * omits them.
 */
export function mergeRecord(known, fresh) {
  if (!known) {
    return fresh;
  }
  return {
    ...known,
    ...Object.fromEntries(
      ['name', 'label', 'type', 'room'].filter((k) => fresh[k] !== '').map((k) => [k, fresh[k]]),
    ),
    capabilities: fresh.capabilities.size > 0 ? fresh.capabilities : known.capabilities,
    commands: fresh.commands.size > 0 ? fresh.commands : known.commands,
    attributes: new Map([...known.attributes, ...fresh.attributes]),
  };
}

/** A new record with one attribute changed (a live event). */
export function withAttribute(record, name, value, unit) {
  const attributes = new Map(record.attributes);
  const previous = attributes.get(name);
  attributes.set(name, {
    value: valueOf(value),
    unit: typeof unit === 'string' && unit !== '' ? unit : previous?.unit,
    values: previous?.values,
  });
  return { ...record, attributes };
}

/** The value of one attribute (null when absent). */
export const attr = (record, name) => record?.attributes?.get(name)?.value ?? null;

/** A number of an attribute ("21.5", 21.5), or undefined. */
export function numberAttr(record, name) {
  const v = attr(record, name);
  if (v === null || v === '' || typeof v === 'boolean') {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A string of an attribute, trimmed, or undefined. */
export function stringAttr(record, name) {
  const v = attr(record, name);
  return v === null ? undefined : String(v).trim();
}

/**
 * One live event of the hub (eventsocket, or the `content` of a postURL body):
 * { deviceId, name, value, unit } for a device, undefined otherwise (location
 * events such as the mode or HSM are left out).
 */
export function deviceEventOf(raw) {
  const event = raw && typeof raw === 'object' && raw.content ? raw.content : raw;
  if (!event || typeof event !== 'object' || typeof event.name !== 'string') {
    return undefined;
  }
  if (event.source !== undefined && event.source !== 'DEVICE') {
    return undefined;
  }
  const deviceId = text(event.deviceId);
  if (deviceId === '' || deviceId === '0' || deviceId === 'null') {
    return undefined;
  }
  return {
    deviceId,
    name: event.name,
    value: event.value,
    unit: typeof event.unit === 'string' ? event.unit : undefined,
  };
}
