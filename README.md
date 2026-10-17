# gladys-hubitat

[Gladys Assistant](https://gladysassistant.com) external integration bridging a
**Hubitat Elevation** hub: the devices authorized in its **Maker API** app
become Gladys devices of the Discovery tab, their states follow the hub live
(its event socket), and Gladys controls them through the Maker API, on the
local network only. Made for Hubitat users who move to Gladys at their own
pace, or run both side by side. Unofficial, not affiliated with Hubitat.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against a simulated hub only, never on a
> real Hubitat hub yet. Feedback and bug reports are welcome in the
> [GitHub issues](https://github.com/LM1LC3N7/gladys-hubitat/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HubitatApp) ⇄ src/hubitat.js     ⇄ Maker API (HTTP, local)
                                   │                       ⇄ src/eventsocket.js ⇄ ws://<hub>/eventsocket
                                   ├─ src/records.js    hub answers and events -> records (pure)
                                   ├─ src/mapping.js    one record -> features, readers, writers (pure)
                                   ├─ src/devices.js    records -> Gladys devices + routing tables (pure)
                                   └─ src/publisher.js  states within 300/min, sensor throttling, presses
```

- **Signing in**: the access token of the Maker API app, in the query string
  (`?access_token=`) as the Maker API requires; never logged, never in an
  error message.
- **Inventory**: `GET /apps/api/<app>/devices/all` (capabilities, attributes,
  commands of every authorized device); one Gladys device per hub device,
  named "label (room)". External ids `ext:<selector>:hubitat:<device id>` and
  `…:<key>` (the attribute name, `color`, `door_command`, `button_<n>`).
- **Changes**: the hub's event socket, `ws://<hub>/eventsocket` (JSON events of
  every device; only the authorized ones are kept). The list is read again
  every 5 minutes; without the socket, at the configured pace (30 s by
  default), and the socket is tried again (5 s, doubling up to 2 min). The
  Maker API's `postURL` push needs a port of the container published on the
  LAN, which the Gladys sandbox only offers to sub-containers: not used.
- **Commands**: `GET /apps/api/<app>/devices/<id>/<command>/<value>`. One at
  a time per device (promise chain), sent within 3.5 s of their arrival or
  refused (Gladys acks within 5 s). Locks and garage doors: refused unless
  allowed in the configuration, on a state read just before
  (`GET /devices/<id>`), refused when unknown or moving. No HSM nor mode
  command exists in the code (a test checks it).
- **Failures**: hub unreachable → status message and `unreachable` badges,
  reconnection after 5 s doubling up to 60 s; token refused or wrong app
  number → every 5 minutes; a 429 pauses every path (Retry-After, 1 min to
  6 h). A device Hubitat reports offline (`healthStatus`) gets an unreachable
  badge; no live events, an orange dot.

## Reused work

- [jason0x43/hacs-hubitat](https://github.com/jason0x43/hacs-hubitat) (MIT),
  the Home Assistant integration of the Maker API, actively maintained. It is
  Python and cannot run in this Node container: its logic is **ported** (the
  Maker API paths and answer shapes, the capability / attribute / command
  names and values, the light heuristics, the `setColor` map, the button
  events), with its MIT notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
  copied into the image. Two of its test fixtures are reused.
- The official [Maker API documentation](https://docs2.hubitat.com/en/apps/maker-api)
  of Hubitat.
- [LM1LC3N7/gladys-homey](https://github.com/LM1LC3N7/gladys-homey) and
  [LM1LC3N7/gladys-domoticz](https://github.com/LM1LC3N7/gladys-domoticz),
  bridges of the same author: the app structure, the state publisher and the
  test helpers.

No JavaScript Maker API client is maintained on npm; the only runtime
dependency is the Gladys SDK (the WebSocket is the one built into Node.js).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/devices-all.json` holds a `/devices/all` answer of 17 devices
of every kind (written from the Maker API documentation; not captured on a
real hub). `test/helpers/fakeHub.js` serves it to the app tests (mocked
timers); `test/helpers/hubServer.js` is a simulated hub on 127.0.0.1 (Maker
API over HTTP and a minimal WebSocket event socket), against which
`test/e2e.test.js` runs the real client and socket. See TODO.md, "To check
on a real hub".

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store.

## License

Apache-2.0 (see [LICENSE](LICENSE)); ported logic under MIT, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Hubitat and Hubitat
Elevation are trademarks of Hubitat, Inc.; this project is not affiliated with
Hubitat.
