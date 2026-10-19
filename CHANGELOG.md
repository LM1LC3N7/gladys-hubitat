# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Energy indexes: a jump could be billed in full in the Energy tab (no check
  of the rise), and a drop was taken by the next reading above it. Every
  energy feature now has the index guard of P1 Monitor: 0 never published, a
  drop or a jump above 25 kW on average held back (the last accepted value
  sent again), shown on the device badge and in the log, kept in `/data`
  across restarts, and taken only by the new "Accept the held index" button,
  bounded to the value shown, which answers with the kWh counted. Neither
  saving the configuration nor a reconnection accepts it; creating a device
  resets its guard.

## [0.1.1] - 2026-10-17

### Added

- The devices authorized in the Maker API of a Hubitat Elevation hub, offered
  in the Discovery tab: switches, dimmers, colour and white bulbs, plugs with
  power, energy, voltage and current, shades (open, close, stop, position),
  thermostats (heating and cooling setpoints, mode, activity), locks, garage
  doors, buttons (one per number: pushed, double tapped, held, released),
  contact, motion, leak, smoke, CO, tamper and presence sensors, temperature,
  humidity, illuminance, CO2, UV index and battery.
- Live states through the hub's event socket, a full read every 5 minutes, and
  reads at a configurable pace without it.
- Commands through the Maker API: one at a time per device, sent within 3.5 s
  or refused.
- Locks and garage doors read-only by default (two options to allow them),
  commanded on a state read just before, refused when unknown or moving, then
  guarded until they report the state asked for (20 s / 60 s at most). The
  garage door command is a shutter-like control, never a switch. The switch
  of a lock, door, valve, siren or keypad stays read-only. No HSM or mode
  command.
- Temperatures in °C, converted from a Fahrenheit hub; setpoints refused when
  the hub's units contradict the option or the current setpoint is unknown or
  implausible in its scale (°C up to 35, °F from 39), with or without live
  events.
- A watchdog that opens the event socket again at once when it misses a
  change or stays silent for 30 minutes; reads merged with the events
  received meanwhile.
- Energy index protected against drops (taken only when the index rises again
  above the low value); Wh converted to kWh.
- Transport badges (hub unreachable, device offline, live events lost), a
  "Test the connection" button, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hubitat/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-hubitat/releases/tag/v0.1.1
