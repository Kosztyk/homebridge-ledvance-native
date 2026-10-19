# Homebridge LEDVANCE Native

Homebridge plugin for devices paired with the **LEDVANCE SMART+ WiFi** app, or the **Sylvania** app using its separate US login. Uses your existing app email and password.

## Devices and HomeKit controls

| Device | Controls |
| --- | --- |
| On/off and dimmable lights | Power and supported brightness controls |
| Tunable-white and RGB lights | Power, brightness, colour temperature and/or hue and saturation |
| Dual-channel `mix_rgbcw` lamps | Independent Main light and Secondary light, plus optional All lights |
| Smart plugs and switches | Outlet by default; optional Switch type override |
| Power strips | Separate outlets and supported USB outputs, plus optional All Outlets |
| Supported additional features | Optional child-lock and scene/music work-mode switches |
| Power-monitoring plugs/strips | Voltage, current, watts and cumulative energy in compatible HomeKit apps |

Devices must expose the corresponding data points in their cloud schema. This release does not implement cameras, thermostats, vacuums, arbitrary sensors, Bluetooth-only products, or Zigbee devices that lack suitable cloud data points. Unknown devices are logged and skipped.

Apple Home does not show the custom energy measurements. Compatible apps such as Eve can read them; energy history is not recorded. Power-strip measurements apply to the whole strip and are attached to its first outlet. Countdown and power-on-behaviour settings from Home Assistant are not exposed as HomeKit controls.

## Install the supplied release

Copy `homebridge-ledvance-native-1.0.0.tgz` to the Homebridge machine and run:

```bash
sudo npm install -g --omit=dev ./homebridge-ledvance-native-1.0.0.tgz
```

In Homebridge, open **Plugins → LEDVANCE Native → Settings**, enter your app email/password, select the region, save and restart Homebridge. **EU** is the starting choice for a Romanian LEDVANCE account. Leave **Device overrides** empty for automatic discovery.

This is a local installable release. It will appear in npm/Homebridge search only after you publish it to npm and the Homebridge index updates.

An install helper is included in the source archive:

```bash
bash scripts/install-local.sh /full/path/homebridge-ledvance-native-1.0.0.tgz
```

## Minimal configuration

Homebridge UI adds the platform entry for you. When editing JSON manually, add this object to the top-level `platforms` array:

```json
{
  "name": "LEDVANCE Native",
  "email": "your-ledvance-account@example.com",
  "password": "YOUR_LEDVANCE_APP_PASSWORD",
  "region": "EU",
  "platform": "LedvanceNative"
}
```

Use your LEDVANCE app account, not a Tuya Smart/Smart Life account. The Sylvania account pool is separate: select **US (Sylvania app)** for that app. Optional `countryCode` overrides the region's calling code, for example `40`. Do not set it unless your login needs it.

## Local control and IP changes

On startup the plugin retrieves device schemas and local keys from the LEDVANCE cloud. It listens for Tuya advertisements on UDP 6666/6667/7000 and sends active discovery requests on UDP 7000. Discovered LAN protocol versions are used instead of the unrelated `pv` cloud field.

Commands and state reads try LAN first, then fall back to cloud. Local sockets close after each operation so the plugin does not reserve a permanent device connection. Devices with protocols 3.1–3.5 are handled through TuyAPI. LAN detection requires devices and Homebridge to share a broadcast network; containers generally need host networking for this. Devices use TCP 6668 for local communication.

After a router restart or DHCP change, a new advertisement updates the address immediately. Active discovery runs every 300 seconds by default; the plugin does not reuse a cloud-reported WAN IP as a LAN address. A fixed per-device IP override takes precedence over discovery and must be updated manually if that address changes.

Some devices accept only one local connection at a time. If Home Assistant, the mobile app or another plugin competes for it, try setting `localControl` to `false`. Cloud control remains available. Your Home Assistant integration can continue running; the Homebridge plugin operates independently.

## Optional device overrides

Copy device IDs from the discovery log. For example:

```json
"devices": [
  {
    "id": "YOUR_DEVICE_ID",
    "name": "Living Room LED Strip",
    "minKelvin": 2700,
    "maxKelvin": 6500
  },
  {
    "id": "ANOTHER_DEVICE_ID",
    "exclude": true
  }
]
```

Other overrides: `type` (`auto`, `light`, `outlet`, `switch`), `ip` and `version`. Prefer automatic detection. Entries without an ID are ignored. Excluding a cached device removes its HomeKit accessory on the next restart. Removing the exclusion restores it.

Dual-channel lamps expose several Lightbulb services in one accessory. In Apple Home, open the accessory's settings to show its controls separately if preferred. White controls never change the RGB channel's colour or brightness, and RGB controls preserve the white channel. The All lights control enables/disables both channels.

## Timing and reliability

| Setting | Default | Purpose |
| --- | ---: | --- |
| `localPollInterval` | 5 s | Local state reads |
| `pollInterval` | 30 s | Cloud state fallback when LAN is unavailable |
| `discoveryInterval` | 600 s | Discover new devices and refresh schemas/local keys |
| `lanDiscoveryInterval` | 300 s | Active LAN discovery probes |
| `localTimeout` | 2 s | Maximum time for one LAN attempt |
| `requestTimeout` | 8 s | Timeout for one cloud API request |
| `offlineGrace` | 120 s | Retain last confirmed state during brief failures |

HomeKit reads use the confirmed state cache. Commands are serialized per device, and related colour changes are combined over 120 ms. State updates only after a successful LAN acknowledgement or cloud acceptance; the next poll confirms it. Cloud acceptance does not guarantee immediate physical execution by an offline device.

Accessories retain stable IDs across restarts. Temporary discovery failures do not delete accessories. A device that cannot be reached eventually returns No Response; restart-restored cached state is unconfirmed until the device/cloud responds. To remove a device permanently, exclude its ID. Multiple accounts need separate Homebridge instances because the settings declare a single platform per instance.

Sessions and refresh tokens are reused, including a silent refresh before password login. A rate limit pauses cloud requests for 60 seconds; local devices remain controllable. The plugin does not continuously retry a rejected password.

The Homebridge storage directory contains a private cache with session tokens and local keys, written with owner-only permissions. Your password stays in Homebridge's normal configuration; it is not duplicated in the cache. Logs omit passwords, tokens, keys and signed URLs. Do not upload your live Homebridge config or cache to GitHub.

## Troubleshooting

- **Login rejected:** verify the app account, region, and password. Select the Sylvania option only for that app. Repeated login attempts may trigger the provider's temporary rate limit.
- **No devices:** confirm they belong to this account in the chosen app. The plugin reads every home returned by the account. Enable `debug` to see transport choices and unsupported schema codes.
- **Slow commands:** debug logs show LAN address discovery and whether the command used LAN or cloud. Verify broadcast networking or use an explicit IP/protocol override.
- **Light immediately changes back:** verify the next poll confirms the physical device state; check for another integration or automation changing it. Failed commands return an error to HomeKit.
- **Device removed from the app remains in HomeKit:** this is deliberate. Add its ID with `exclude: true` and restart.
- **npm search does not find it:** install the provided tarball until you publish the package.

## Development and publishing

Requires Node 20.19+, 22, 24 or 26 and Homebridge 1.8+ or 2.x. Node 22/24/26 should be used with Homebridge 2.x according to Homebridge's own runtime requirements. Development verification uses Homebridge 2.4.0 with real HAP services and simulated LEDVANCE transports. Live device/account verification is still required on your installation.

The source is ordinary CommonJS JavaScript; there is no compilation step or missing `dist` folder. `index.js` and every runtime file under `lib/` are explicitly included in the npm package.

```bash
npm ci
npm test
npm run check
npm pack
```

The source archive includes the lockfile, test suite, install helper, CI workflow and documentation. To publish under your npm account:

```bash
npm login
npm publish --access public
```

To put the project on GitHub, create an empty repository named `homebridge-ledvance-native` under `Kosztyk`, then run these commands **inside the extracted project folder**:

```bash
git init -b main
git add .
git commit -m "Initial LEDVANCE Native Homebridge plugin 1.0.0"
git remote add origin https://github.com/Kosztyk/homebridge-ledvance-native.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

Repository URLs in `package.json` are the intended destination; this release does not create a GitHub repository or publish to npm automatically. `author: Kosztyk` is package metadata; npm ownership belongs to the account that publishes it.
