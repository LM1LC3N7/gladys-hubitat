// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { LANGUAGES, POLL_INTERVAL, SENSOR_INTERVAL, TEMPERATURE_SCALES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  hub_address: '',
  app_id: '',
  access_token: '',
  temperature_scale: 'C',
  language: 'fr',
  live_events: true,
  poll_interval: POLL_INTERVAL.default,
  sensor_interval: SENSOR_INTERVAL.default,
  allow_lock_control: false,
  allow_garage_door_control: false,
};

/**
 * The base address of the hub from what the user typed: "192.168.1.50",
 * "http://192.168.1.50/", or a Maker API URL copied from the app page
 * ("http://192.168.1.50/apps/api/12/devices").
 * @returns {{ url: string, appId?: string } | { error: 'empty' | 'invalid' | 'credentials' | 'cloud' | 'token-in-address' | 'local-name' }}
 */
export function parseHubAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { error: 'empty' };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return { error: 'invalid' };
  }
  if (url.username || url.password) {
    return { error: 'credentials' };
  }
  if (url.searchParams.has('access_token')) {
    // The address field is not a secret: the token belongs in its own field.
    return { error: 'token-in-address' };
  }
  if (/(^|\.)hubitat\.com$/i.test(url.hostname)) {
    // The cloud endpoints of the Maker API go through Hubitat's servers: local only.
    return { error: 'cloud' };
  }
  if (/\.local$/i.test(url.hostname)) {
    // mDNS names do not resolve in the container (bridge network).
    return { error: 'local-name' };
  }
  const app = /\/apps\/api\/(\d+)(?:\/|$)/.exec(url.pathname);
  return app ? { url: url.origin, appId: app[1] } : { url: url.origin };
}

const bounded = (raw, { min, max, default: fallback }) => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const bool = (raw, fallback) => {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true' || raw === 1 || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === 0 || raw === '0') {
    return false;
  }
  return fallback;
};

/**
 * @returns {{ url?: string, appId: string, token: string, error?: string,
 *   temperatureScale: 'C'|'F', language: 'fr'|'en', live: boolean, pollInterval: number,
 *   sensorInterval: number, allowLock: boolean, allowGarage: boolean }}
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const c = { ...DEFAULTS, ...given };
  const target = parseHubAddress(c.hub_address);
  const typedApp = String(c.app_id ?? '').trim();
  const appId = typedApp || target.appId || '';
  const token = String(c.access_token ?? '').trim();
  let error = target.error;
  if (!error && !/^\d{1,9}$/.test(appId)) {
    error = appId === '' ? 'no-app' : 'bad-app';
  }
  if (!error && token === '') {
    error = 'no-token';
  }
  const scale = String(c.temperature_scale).toUpperCase();
  return {
    url: target.url,
    appId,
    token,
    error,
    temperatureScale: TEMPERATURE_SCALES.includes(scale) ? scale : DEFAULTS.temperature_scale,
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULTS.language,
    live: bool(c.live_events, DEFAULTS.live_events),
    pollInterval: Math.round(bounded(c.poll_interval, POLL_INTERVAL)),
    sensorInterval: Math.round(bounded(c.sensor_interval, SENSOR_INTERVAL)),
    // Louis's rule: locks and garage doors stay read-only unless allowed.
    allowLock: bool(c.allow_lock_control, false),
    allowGarage: bool(c.allow_garage_door_control, false),
  };
}
