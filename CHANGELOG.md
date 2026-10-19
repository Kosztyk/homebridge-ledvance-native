# Changelog

## 1.0.0

- Port the LEDVANCE/Sylvania app login and automatic cloud device discovery from the supplied Home Assistant integration.
- Add LAN discovery, DHCP address refresh, bounded local requests and cloud fallback.
- Support dimmable, tunable-white and RGB lights, including independent mix_rgbcw white/RGB channels.
- Support smart plugs, power-strip outlets, USB outputs and optional master, child-lock and effect controls.
- Expose supported energy measurements to compatible HomeKit apps.
- Add private session/device caching, silent token refresh, serialized commands and batched colour changes.
- Retain accessory identities and confirmed state through temporary connection failures.
- Include the Homebridge settings schema, tests, package lock, install helper and publish instructions.
