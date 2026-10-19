# Hubitat Elevation

This integration connects Gladys to **your Hubitat Elevation hub** through its
**Maker API** app, and offers the devices you authorize there in the
**Discovery** tab of Gladys: switches, dimmers, colour and white bulbs, plugs
with their consumption, shades, thermostats, locks, garage doors, buttons and
sensors. Once a device is added, its state follows the hub **live**, and Gladys
controls it **through the hub**, which keeps its Z-Wave, Zigbee, Matter and
LAN devices. Everything stays on your local network. Unofficial, not
affiliated with Hubitat.

> **Development version (0.1).** Written from the Maker API documentation and
> the Home Assistant integration of the same API, and tested against a
> simulated hub: it has never been tested on a real Hubitat hub yet. Your
> feedback is welcome on the GitHub repository.

## What you get

| Hubitat capability                                                  | In Gladys                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Switch`, `SwitchLevel`                                             | a light (bulbs, dimmers), else a switch (outlets, relays)      |
| `ColorControl`, `ColorTemperature` (`colorMode`)                    | colour (RGB) and colour temperature, the one the bulb shows    |
| `PowerMeter`, `EnergyMeter`, `VoltageMeasurement`, `CurrentMeter`   | power, energy (meter), voltage and current                     |
| `WindowShade`, `WindowBlind`                                        | a shutter: open, close, stop, position                         |
| `Thermostat` (heating and cooling setpoints, mode, operating state) | a thermostat, setpoints in °C                                  |
| `Lock`                                                              | a lock, **read-only unless you allow it**                      |
| `GarageDoorControl`, `DoorControl`                                  | a door sensor, and a command **read-only unless you allow it** |
| `PushableButton`, `HoldableButton`, `DoubleTapableButton`…          | one button per number: pushed, double tapped, held, released   |
| `ContactSensor`, `MotionSensor`, `WaterSensor`                      | opening, motion and leak sensors                               |
| `SmokeDetector`, `CarbonMonoxideDetector`, `TamperAlert`            | smoke, CO and tamper sensors                                   |
| `TemperatureMeasurement`, `RelativeHumidityMeasurement`             | temperature (°C) and humidity                                  |
| `IlluminanceMeasurement`, `CarbonDioxideMeasurement`, `Battery`…    | illuminance, CO2, UV index, battery, presence                  |

Each hub device makes **one Gladys device**, named after its label and room
("Ceiling light (Living room)"); its hub id, room and driver are kept in its
parameters. Devices with none of these capabilities (speakers, for now) are
left out. Water valves are not controlled. The switch of a device that is also
a lock, a garage door, a valve, a siren or a security keypad is shown
read-only, whatever the options: a "turn everything off" scene never reaches
it.

## Requirements

- A Hubitat Elevation hub (C-5, C-7, C-8 or later) on the same local network
  as Gladys.
- The **Maker API** app installed on the hub (built in).

## Installation

1. In the Hubitat web interface, **Apps → Add Built-In App → Maker API**.
   Select the devices Gladys may see and control, and click **Done**. Leave
   "Allow Access via Remote / Cloud" off: Gladys uses the local endpoints.
2. Open the Maker API app again: its page shows URLs like
   `http://192.168.1.50/apps/api/12/devices?access_token=…`. Note:
   - the **address** of the hub (`192.168.1.50`),
   - the **app number** (`12`, after `/apps/api/`),
   - the **access token** (after `access_token=`).
3. In Gladys, open the integration, **Configuration**, and fill in the three
   fields. You may paste a Maker API URL in the address field, without its
   access token: the address and the app number are taken from it.
4. Click **Test the connection**: the number of authorized devices, the
   devices offered and whether the live events work show up.
5. Open the **Discovery** tab and add the devices you want. Their values are
   sent as soon as they are added.

## Options

- **Temperature scale of the hub**: the scale set in Hubitat (Settings →
  Location and modes). Gladys always shows °C and converts; when the hub gives
  the unit of a reading, the unit wins, and is kept for the next reads. When
  the hub's units disagree with the option, the connection status says so and
  thermostat setpoints are refused. A setpoint is sent in the scale of the
  hub's unit when known, else in the scale of this option (live events or
  not), and only when the current setpoint is known and plausible in that
  scale: up to 35 in °C, from 39 in °F. A °F hub set to °C here is caught that
  way.
- **Live events** (on by default): the integration listens to the event socket
  of the hub (`ws://<hub>/eventsocket`). The changes reach Gladys within a
  second, and the button presses reach your scenes. Off, or when the socket is
  lost, the devices are read at the interval below.
- **Read interval without live events**: 30 seconds by default (10 to 3600).
  With the live events, the whole list is read every 5 minutes anyway.
- **Minimum interval between two readings of a sensor**: 10 seconds by default
  (0 to 300). A plug that reports its power every second is sent to Gladys at
  this pace. Switches, lights, buttons, motion and contact sensors are never
  delayed.
- **Language of the feature names**: French or English, for the devices added
  from now on.
- **Allow lock control from Gladys** (off by default): see Safety.
- **Allow garage door control from Gladys** (off by default): see Safety.

## Safety

- **Locks and garage doors are read-only by default.** Their state shows up,
  but every command is refused until you turn on the matching option. Once on,
  Gladys can **unlock** your door and **open** your garage, from the dashboard,
  your scenes and the voice assistants. The garage door command works like a
  shutter (open 1, close -1; stop only when the opener has a stop command):
  a scene acting on every shutter reaches it too.
- Before a lock or garage door command, the integration **reads the device
  again** on the hub, and refuses when its state is unknown or moving
  (opening, closing); nothing is sent when it is already in place.
- After the command, the device is **guarded**: any other lock or garage door
  command on it is refused ("a command is already in progress") until it
  reports the state asked for, or for 20 seconds (lock) / 60 seconds (garage
  door). A late report of the old state or an unknown state never lifts the
  guard. Stopping a moving garage door (when the opener has a stop command)
  stays possible during the guard. The device is read again after 5 and 15 seconds (and 30 and 60 for a
  garage door); when these reads fail, or the state never comes, its badge
  says "state not confirmed".
- The commands of one device are sent **one at a time**. Gladys waits 5
  seconds for an answer: a command that could not leave within 3.5 seconds
  is refused, never sent late.
- The integration **never changes the alarm (HSM) nor the modes** of the hub:
  there is no such command in it.

## Good to know

- **The hub stays in charge of the devices**: Gladys sends its commands to the
  Maker API, which drives them. Keep the hub running.
- **Buttons**: each button number is a feature (`Button 1`, `Button 2`…).
  Pushed is a click, double tapped a double click, held a long press, released
  its end (a release without a hold before is a plain "release"). The presses
  only arrive through the live events: with them off, the buttons stay silent.
- **Live events watchdog**: when a full read finds a two-state change (switch,
  contact, motion, lock, door…) that no event told, or when the socket said
  nothing for 30 minutes, the socket is opened again at once; the badges only
  turn orange if that reopening fails.
- **Energy**: Gladys counts every rise of an energy index in full in the
  Energy tab. So the integration never publishes 0, and holds back any
  abnormal value: a drop, or a jump of more than 25 kW on average since the
  last accepted value (plus a 0.5 kWh slack). While a value is held, the last
  accepted one is sent again, the badge of the device turns orange with the
  jump or the drop and the kWh at stake, and the log says so. Neither
  repetition, time, a later rise, saving the configuration nor a reconnection
  accepts it: only the **Accept the held index** button of the configuration
  does, and it takes exactly the value shown (plus what the device may have
  used since), answering with the kWh counted. An accepted jump is counted at
  once as consumption; an accepted drop (a meter reset by `resetEnergy`)
  bills nothing. A value back to normal ends the hold. The hold is kept in
  `/data` across restarts; creating the device (again) starts afresh. A
  driver reporting Wh is converted to kWh.
- **The event socket carries the events of every device of the hub**, not
  only those you authorized: the integration keeps the authorized ones and
  drops the rest. It needs no token.
- **Door contacts**: Gladys shows 0 for open and 1 for closed; the integration
  converts.
- **Transport badge**: a device turns "unreachable" when the hub is, or when
  Hubitat reports it offline (`healthStatus`); an orange dot means the live
  events are lost and the state is read at the configured interval.
- **Devices authorized later** in the Maker API show up in Discovery at the
  next full read (5 minutes at most). The **Scan** button reads them at once.

## Troubleshooting

| Status message                            | What to do                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| The Maker API refused the access token    | Copy the token again from the Maker API app page.                                          |
| No Maker API app answers with this number | Check the app number, after `/apps/api/` in the URLs of the app.                           |
| The Hubitat hub is unreachable            | Check the address, seen from the Gladys machine (not `localhost`), and that the hub is on. |
| The address contains the access token     | Keep only the address of the hub in that field, and paste the token in its own field.      |
| No live events from the hub               | Gladys reads the devices at the configured interval meanwhile, and tries again by itself.  |

The logs of the integration (Gladys, integration page) give the details.

## Privacy

Everything stays on your local network: the integration only talks to your
hub, over the Maker API and its event socket. The access token is kept by
Gladys in its database, never shown again, and sent only to your hub; it is
never written to the logs. Hubitat and Hubitat Elevation are trademarks of
Hubitat, Inc.; this integration is not affiliated with Hubitat.
