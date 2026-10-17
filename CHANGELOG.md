# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
  commanded on a state read just before, refused when unknown or moving. No
  HSM or mode command.
- Temperatures in °C, converted from a Fahrenheit hub.
- Transport badges (hub unreachable, device offline, live events lost), a
  "Test the connection" button, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hubitat/commits/main
