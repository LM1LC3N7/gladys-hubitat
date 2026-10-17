# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, under its own licence.

## hacs-hubitat

- Project: [jason0x43/hacs-hubitat](https://github.com/jason0x43/hacs-hubitat),
  the Home Assistant integration of Hubitat Elevation hubs through the Maker
  API, and its `hubitatmaker` client.
- What is ported (rewritten in JavaScript in `src/records.js`,
  `src/mapping.js` and `src/hubitat.js`): the Maker API paths and the shapes
  of its answers (device list, device details, commands, events), the
  capability, attribute, command and state names, the light heuristics (which
  devices are lights, hue in 0-100, colour temperature in kelvins, the
  `colorMode` switch), the `setColor` JSON map, the window shade, garage door,
  lock and thermostat values, and the button events (pushed, held,
  doubleTapped, released).
- Test fixtures `test/fixtures/device-details.json` and the event samples of
  `test/fixtures/events.json` are derived from its test fixtures.
- Licence: MIT.

```
MIT License

Copyright (c) 2020 Jason Cheatham

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
