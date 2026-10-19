# Release validation — 1.0.0

Validated on 19 October 2026 with Node.js 24.19.0, npm 11.9.0, Homebridge 2.4.0 and TuyAPI 7.7.1.

- **56 automated tests passed**, covering OEM signing/RSA vectors, region selection, discovery, token refresh, rate limits, credential rejection, colour formats, channel isolation, HomeKit controls, command failure, state recovery, caching and concurrent writes.
- Protocol signing, RSA and mixed-light payload vectors were independently generated with Python standard-library implementations matching the supplied Home Assistant integration.
- Real TuyAPI encrypted TCP reads/writes were exercised against a simulated LAN device, including timeout cleanup and protection against late writes after cloud fallback.
- Accessory tests use real Homebridge PlatformAccessory and HAP-NodeJS Lightbulb/Outlet/Switch services.
- A clean installation of the npm tarball resolved production dependencies successfully. Homebridge 2.4.0 loaded and registered the installed package, initialized its platform, and started/stopped cleanly.
- JavaScript syntax, JSON, Homebridge configuration schema, package entry point and runtime file inclusion were checked.

No live LEDVANCE account or physical device was accessed. Physical device behavior, provider login acceptance and LAN protocols 3.4/3.5 still need verification on the target installation. These versions use TuyAPI's protocol implementations; the simulated TCP tests exercise protocol 3.3.

The source archive contains the complete runnable source, package lock, tests, CI workflow, install helper and documentation. No passwords or user account sessions are included. The placeholder test values are synthetic.
