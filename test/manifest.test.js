// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake and a BOM (lesson of the first wave).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  LANGUAGES,
  POLL_INTERVAL,
  SENSOR_INTERVAL,
  TEMPERATURE_SCALES,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-hubitat:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-hubitat/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`).replace(/\s*\n>?\s*/g, ' ');
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Hubitat|sans\s+lien\s+avec\s+Hubitat/);
    assert.match(docs, /never\s+been\s+tested|jamais\s+été\s+testée/);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('no mojibake (UTF-8 read as Latin-1) nor BOM in the text files', () => {
  // "Ã©" for "é", "Â " for a no-break space, "â€" for a dash or a quote…
  const mojibake = /[ÂÃ][\u0080-¿€]|â€/;
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'src/i18n.js',
  ]) {
    const text = read(path);
    assert.ok(!text.startsWith('﻿'), `${path} starts with a BOM`);
    const match = mojibake.exec(text);
    assert.equal(match, null, `${path}: mojibake "${match?.[0]}" at ${match?.index}`);
  }
});

test('the MIT notice of hacs-hubitat ships with the code', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /jason0x43\/hacs-hubitat/);
  assert.match(notices, /Copyright \(c\) 2020 Jason Cheatham/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  assert.match(read('LICENSE'), /Apache License/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || value !== '') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULTS, `${field.key} has no default in the code`);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(
    fields.temperature_scale.options.map((o) => o.value),
    TEMPERATURE_SCALES,
  );
  assert.equal(fields.access_token.type, 'secret', 'the token is never sent back to the browser');
  for (const key of ['hub_address', 'app_id', 'access_token']) {
    assert.equal(fields[key].required, true, key);
  }
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  assert.deepEqual(
    [fields.sensor_interval.min, fields.sensor_interval.max],
    [SENSOR_INTERVAL.min, SENSOR_INTERVAL.max],
  );
  for (const key of ['allow_lock_control', 'allow_garage_door_control']) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false, `${key} is off by default (Louis's rule)`);
  }
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  assert.equal(intro.required, undefined);
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.ok(handlers.includes('onSetValue'), 'the commands go through onSetValue');
  for (const item of manifest.actions) {
    assert.ok(item.timeout_seconds >= 5 && item.timeout_seconds <= 120, item.key);
  }
  // The test button may read the hub (20 s) and open the socket (10 s): 90 s, as commented.
  assert.equal(manifest.actions.find((a) => a.key === ACTIONS.TEST).timeout_seconds, 90);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the token is not said to be encrypted (Gladys keeps secrets in clear in its database)', () => {
  const token = manifest.config_schema.find((f) => f.key === 'access_token');
  for (const lang of ['en', 'fr']) {
    assert.doesNotMatch(token.description[lang], /encrypt|chiffr/i);
    assert.doesNotMatch(read(`docs/${lang}.md`), /encrypt|chiffr/i);
  }
});

test('no code path changes the HSM or the modes of the hub', () => {
  for (const path of ['src/hubitat.js', 'src/constants.js', 'src/app.js', 'src/mapping.js']) {
    const code = read(path);
    assert.doesNotMatch(code, /['"`/]hsm\b|['"`/]modes\b|armAway|armHome|armNight|disarm/i, path);
  }
});
