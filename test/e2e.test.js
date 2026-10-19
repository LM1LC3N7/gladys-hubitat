// -----------------------------------------------------------------------------
// The whole integration, real HTTP client and real WebSocket, against the
// simulated hub of test/helpers/hubServer.js on 127.0.0.1 (never the
// network), with the SDK's fake Gladys. Real time: a few hundred ms.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HubitatApp } from '../src/app.js';
import { ACTIONS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { APP_ID, TOKEN } from './helpers/fakeHub.js';
import { hubServer, waitFor } from './helpers/hubServer.js';

test('a Hubitat hub, end to end: devices, live states, commands, presses, test', async (t) => {
  const sim = await hubServer();
  const gladys = createFakeGladys({
    config: { hub_address: sim.url, app_id: APP_ID, access_token: TOKEN },
  });
  const app = new HubitatApp({
    gladys,
    logger: createLogger({ level: 'silent' }),
    store: createMemoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    await sim.close();
  });
  await gladys.connect();
  await waitFor(() => app.liveState === 'live');
  assert.equal(gladys.fake.discoveredDevices.length, 16);
  assert.ok(sim.requests.every((r) => r.token === TOKEN));

  const named = (name) => gladys.fake.discoveredDevices.find((d) => d.name === name);
  const lamp = named('Plafonnier (Salon)');
  const remote = named('Télécommande (Salon)');
  await gladys.fake.deviceCreated(lamp);
  await gladys.fake.deviceCreated(remote);

  sim.emit('101', 'switch', 'off');
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${lamp.external_id}:switch`) === 0;
  });

  const level = lamp.features.find((f) => f.external_id.endsWith(':level'));
  const ack = await gladys.fake.setValue(lamp, level, 30);
  assert.equal(ack.success, true, ack.error);
  assert.equal(sim.requests.at(-1).path, `/apps/api/${APP_ID}/devices/101/setLevel/30`);
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${lamp.external_id}:level`) === 30;
  });

  sim.emit('114', 'pushed', 3);
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${remote.external_id}:button_3`) === 1;
  });

  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(
    tested.data.message.en,
    /^Connection OK, Maker API app 12 at http:\/\/127\.0\.0\.1:\d+: 17 authorized devices, 16 devices offered in Discovery, 1 left out .+ Live events: OK\.$/,
  );

  sim.drop();
  await waitFor(() => app.liveState === 'down');
  await waitFor(() => app.liveState === 'live', 8000); // opened again after 5 s
  assert.equal(sim.upgrades, 3, 'the app, the test, the app again');
});
