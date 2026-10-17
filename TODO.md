# TODO — Hubitat Elevation v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test` (Node
  22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-17): Maker API client (devices/all,
      device, commands), event socket, mapping of the capabilities (switches,
      dimmers, colour/CT bulbs, plugs with metering, shades, thermostats,
      locks, garage doors, buttons, sensors), lock and garage door safety
      (options off, serialized, fresh read, refused when unknown or moving),
      3.5 s command deadline, 429 pause, badges, test button, en/fr, docs,
      cover. Tested against simulated answers and a simulated hub only.
- [ ] **Milestone 2 — real hub**: run against a real hub (C-7 or C-8) and
      compare with its device pages (see "To check"); turn the answers
      (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: fans (FanControl speeds), valves behind an
      option (Louis's rule: closing and opening off by default), the hub mode
      and HSM status as read-only text features (never commanded), hub
      variables, `setColor` with transitions, scene triggers for buttons
      (`scene_triggers`), sirens (Alarm) behind an option.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real hub

- The exact shape of `/devices/all` on a current firmware (2.4.x): attributes
  as an object (`{ "switch": "on" }`) and commands as strings or
  `{ command }` objects are both read; `room` present or not.
- Whether `/devices/all` lists every authorized device on big installs (some
  forum posts suggest it may be slow: the timeout is 60 s).
- The event socket (`ws://<hub>/eventsocket`): that it stays open for days,
  that it needs no login when Hub Login Security is on, the exact JSON of an
  event (`deviceId` number or string, `unit` of a temperature), and whether it
  sends pings.
- `setColor` with a URL-encoded JSON map as the secondary value (what
  hacs-hubitat sends, unencoded through aiohttp): does the hub decode `%7B…`?
  Otherwise send `setHue` + `setSaturation`.
- `setThermostatMode` with `emergency heat` (space encoded as `%20`).
- The answer to a wrong token (401 or 200 with `{ error: true }`) and to a
  wrong app number (404 or an HTML page): both are handled, the messages
  depend on it.
- `energy` reset by the user (`resetEnergy`): the Gladys core sees a meter
  going down.
- Whether `numberOfButtons` events come when a driver changes it.

## Decisions

- **Reference reused: jason0x43/hacs-hubitat** (MIT, maintained, the Home
  Assistant integration of the Maker API). Python, so its logic is ported to
  JavaScript (Maker API paths, answer shapes, capability, attribute, command
  and state names, light heuristics, `setColor` map, button events), with its
  MIT notice in `THIRD_PARTY_NOTICES.md` (copied into the image, like
  `LICENSE`). Two of its test fixtures are reused (`device-details.json`,
  `events.json`). No JavaScript Maker API client is maintained on npm. Single
  runtime dependency: the Gladys SDK.
- **Store checked** on 2026-10-17 (`index.json` of the integration store): no
  Hubitat integration.
- **Live events: the event socket**, not the Maker API `postURL`. postURL would
  need an HTTP port of the integration container published on the LAN; the
  Gladys sandbox publishes ports for sub-containers only (`containers[].ports`,
  SDK README). The socket needs no token and carries the events of every
  device of the hub: the app drops those of devices not authorized in the
  Maker API. Without it (option off, refused, lost) the list is read at
  `poll_interval` (30 s by default) and the socket is retried (5 s doubling
  to 2 min); with it, a full read every 5 minutes catches missed events and
  newly authorized devices.
- **External ids**: `hubitat:<hub device id>` (the device id of the hub, the
  same whatever the Maker API instance); feature keys are the attribute names
  (`switch`, `level`, `heatingSetpoint`…) plus `color`, `door_command`,
  `button_<n>`. Never change one.
- **Lights**: a device is a light when it has ColorControl, ColorTemperature,
  Light or Bulb, or SwitchLevel without being a shade, a fan or an Outlet
  (hacs-hubitat's heuristic, minus the label heuristic). Colour temperature in
  mireds (153–500, as the other bridges of the author), sent in kelvins;
  `colorMode` hides the colour or the temperature not shown. `setColor` keeps
  the current level.
- **Temperatures**: every temperature feature in °C (units are frozen at
  creation, and the user may change the hub scale); the hub scale comes from
  the unit of the event when given, else from the `temperature_scale` option
  (°C by default). Setpoints sent in whole °F or half °C, bounded 5–35 °C.
- **Locks (Louis's rule)**: `allow_lock_control` off by default. The lock
  feature is declared writable (features are frozen at creation) but every
  command is refused until the option is on; checked before anything and
  again when the command gets its turn; the lock read just before
  (`GET /devices/<id>`); refused when that read fails or the state is not
  locked / unlocked; nothing sent when already in place; then guarded (below).
- **Garage doors** (coordinator decision after review, I1): same rule with
  `allow_garage_door_control`. The state is an opening sensor (`door`), the
  command a `shutter/state` feature (`door_command`: OPEN 1, CLOSE -1, STOP 0
  only with a `stop` / `stopPositionChange` command, else refused), like the
  garage "cover" of hacs-hubitat; never a switch ("turn everything off").
  Refused while opening, closing or unknown.
- **Guard after a lock or garage door command** (review B2, wave 3 lesson):
  `{ expected, start, sawMoving, until }` per device, set after the request
  (sent or failed); until it lifts, every guarded command of the device is
  refused ("a command is already in progress"), never answered "already in
  place". Lifted only by the expected state (different from the start, or
  after a move was seen), or at its end (20 s lock, 60 s garage door; then
  "state not confirmed" badge); never by an unknown state. Read backs at 5 and
  15 s (garage: 30 and 60 s too); a failed one sets the "state not confirmed"
  badge, a successful read clears it. The fake hub reports locks and doors
  1 to 5 s late (tests S1 [unlock, lock], S2 [open, close]). Approval: a
  garage door STOP (value 0) skips the guard check, so a moving door can be
  stopped (R2); a command refused as "too late" at the socket never left, so
  it sets no guard (R3).
- **Sensitive switches** (review B1): a device with Lock, GarageDoorControl,
  DoorControl, Valve, Alarm or SecurityKeypad never gets a writable switch.
- **No HSM nor mode command**: the client has no path for them, and a test
  greps the code. Location events of the socket are dropped.
- **Valves**: not controlled in M1 (a valve driver with a Switch shows its
  switch read-only); a later milestone puts them behind an option.
- **Reads merged with the events** (review I2): live events are numbered; a
  read (`/devices/all`, a read back, the fresh read of a command) keeps the
  value of an attribute an event changed after the read started, and keeps
  the units seen in events (I3).
- **Temperature scale** (review I3): a temperature event's unit gives the hub
  scale; a disagreement with the option is logged once and told in the
  connection status. Setpoints (approval R1): scale = the attribute's unit,
  else the hub scale seen, else the option; refused when the hub scale seen
  contradicts the option, or when the current setpoint is unknown or outside
  the band of its scale (disjoint bands: °C only ≤ 35, °F only ≥ 39), which
  also catches a °F hub configured in °C without live events (tests S4b,
  S4c).
- **Socket watchdog** (review I4): when a full read (started after the socket
  opened, compared with a baseline also read after) finds a two-state
  attribute changed without an event, or no message came for 30 minutes, the
  socket is closed and opened again at once, staying "live" with plain badges
  unless the reopening fails (then "down", degraded badges) (R6). A refused
  socket is logged for its first 3 failures, then once in 10 (M7).
- **Reconnection to Gladys** (wave 3 lesson): `connected` calls `resume()`,
  which keeps the client, a 429 pause and a refused token's wait when the
  configuration is the same, and only publishes again. A 429 pause outlives a
  restart, covers the Scan button and the test button (M4).
- **Commands**: their own HTTP agent, 4 sockets (reads never hold them up); the deadline
  guard runs again when the request really leaves (socket connected); the
  option is checked again just before each request (M5, M6).
- **Command deadline**: set_value is acked within 5 s, so a command not sent
  within 3.5 s of its arrival is refused ("took too long"), never sent late;
  the fresh read gets what is left of the 3.5 s, the command 1 s more. The
  requests carry a guard that throws once the deadline is past.
- **Commands serialized per hub device** (a promise chain covering the read and
  the command). After a command: read back at 1.5 s when the live events are
  not on; at 15 s for locks and garage doors. On a refusal or failure, the
  known value is sent again (Gladys shows the value asked for).
- **Errors**: 401/403 or `{ error: true, type: AccessDenied }` = token refused,
  404 = wrong app number: retried every 5 minutes, never in a loop; 429 =
  pause of every path (Retry-After, 1 min to 6 h), commands and read-backs
  included; 5xx, network, timeout = backoff 5 s doubling to 60 s. The
  integration is never left without a retry timer.
- **Token**: in the query string (the Maker API's only way); the URLs are never
  logged nor put in an error; the address field refuses a URL holding
  `access_token=` (that field is not a secret). Kept by Gladys in its database
  in clear (a `secret` field is only hidden in the interface): the docs say so,
  no "encrypted" claim. Cloud endpoints (`cloud.hubitat.com`) refused: local
  only.
- **Buttons**: one `button/click` feature per button number (1–20); pushed →
  CLICK (1), doubleTapped → DOUBLE_CLICK (2), held → LONG_CLICK_PRESS (3),
  released → LONG_CLICK_RELEASE (4) right after a held of the same button,
  else RELEASE (20) (review M1), sent by `publishStates` (two presses are
  two events). Presses come from the live events only (a read cannot tell two
  presses of the same button). They are scene triggers through the "device
  state" trigger of Gladys; dedicated `scene_triggers` are left for later.
- **Energy**: `energy` (kWh) is a cumulative meter: `switch/energy` on a plug,
  `energy-sensor/index` on a meter alone, never a daily value. A unit `Wh`
  is converted to kWh. A lower reading is held; the drop is taken only when a
  later reading is strictly above the low value held (a reset that counts
  again); the same low value read again stays held (review M3, approval R4,
  test S9b [312.4, 0, 0, 312.5]).
- **UV index**: `uv-sensor/integer`, rounded (review I5).
- **Rates**: states through `publishChangedStates` (30-min heartbeat) within
  250 states a minute, measurements spaced by `sensor_interval` (10 s).
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json` and the
  manifest (with the `docker_image` tag `ghcr.io/lm1lc3n7/gladys-hubitat:0.1.0`):
  the one-time exception to "versions belong to the Release workflow"; the
  first patch release gives 0.1.1.
- **Not checked by this session**: the forum thread, Will_71's list, the core
  and GitHub for duplicates (done by the pipeline before the wave); Docker
  build (no Docker on this PC).
