'use strict';

const { LedvanceCloud, REGIONS } = require('./cloud');
const { PrivateStore } = require('./store');
const { LocalTransport } = require('./local');
const { describe, clamp } = require('./model');
const { DeviceAccessory } = require('./accessory');
const PLUGIN_NAME = 'homebridge-ledvance-native';
const PLATFORM_NAME = 'LedvanceNative';

function normalizeConfig(raw = {}) {
  return { ...raw, name: raw.name || 'LEDVANCE Native', region: raw.region || 'EU',
    email: String(raw.email || raw.username || '').trim(), password: String(raw.password || ''),
    localControl: raw.localControl !== false, debug: raw.debug === true,
    pollInterval: clamp(raw.pollInterval || 30, 15, 3600),
    localPollInterval: clamp(raw.localPollInterval || 5, 3, 300),
    discoveryInterval: clamp(raw.discoveryInterval || 600, 60, 86400),
    lanDiscoveryInterval: clamp(raw.lanDiscoveryInterval || 300, 30, 3600),
    localTimeout: clamp(raw.localTimeout || 2, 0.5, 5),
    requestTimeout: clamp(raw.requestTimeout || 8, 3, 30),
    offlineGrace: clamp(raw.offlineGrace || 120, 30, 600),
    exposeMaster: raw.exposeMaster !== false, exposeChildLock: raw.exposeChildLock === true,
    exposeEffects: raw.exposeEffects === true, exposePower: raw.exposePower !== false,
    devices: Array.isArray(raw.devices) ? raw.devices.filter(d => d && typeof d.id === 'string' && d.id.trim()).map(d => ({ ...d, id: d.id.trim() })) : [],
  };
}

class LedvancePlatform {
  constructor(log, config, api) {
    this.log = log; this.api = api; this.config = normalizeConfig(config);
    this.hap = api.hap; this.accessories = new Map(); this.controllers = new Map();
    this.devices = new Map(); this.locks = new Map(); this.stopped = false;
    this.store = new PrivateStore(api.user.storagePath(), this.config, log);
    this.cloud = new LedvanceCloud({ ...this.config, region: REGIONS[this.config.region] ? this.config.region : 'EU' }, {
      tokens: this.store.data.tokens, onTokens: tokens => this.store.update({ tokens }),
    });
    this.local = new LocalTransport(this.config, log, address => {
      const device = this.devices.get(address.id);
      if (device) {
        device.lanIp = address.ip; device.lanVersion = address.version; device.localRetryAt = 0;
        this.debug(`${device.name}: LAN address ${address.ip}, protocol ${address.version}`);
        this.saveDevices();
      }
    });
    api.on('didFinishLaunching', () => this.start().catch(error => this.log.error(`LEDVANCE startup: ${error.message}`)));
    api.on('shutdown', () => this.shutdown());
  }
  debug(message) { if (this.config.debug) this.log.info(`[debug] ${message}`); }
  options(id) { return this.config.devices.find(d => d.id === id) || {}; }
  configureAccessory(accessory) {
    const id = accessory.context?.deviceId;
    if (id) this.accessories.set(id, accessory);
  }
  async start() {
    if (this.stopped) return;
    if (!this.config.email || !this.config.password || !REGIONS[this.config.region]) {
      this.log.error('Set your LEDVANCE email, password and region in the plugin settings, then restart Homebridge.');
      return;
    }
    for (const cached of this.store.data.devices || []) {
      if (!cached?.id || !Array.isArray(cached.schema)) continue;
      this.devices.set(cached.id, { ...cached, lastSeen: 0, online: false, lastCloudPoll: 0, localRetryAt: 0 });
    }
    for (const [id, accessory] of this.accessories) {
      if (this.options(id).exclude) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(id);
      }
    }
    for (const device of this.devices.values()) this.attach(device);
    this.local.start();
    this.pollTimer = setInterval(() => this.refreshAll().catch(error => this.debug(error.message)), this.config.localPollInterval * 1000);
    this.pollTimer.unref?.();
    // Start cached LAN devices even if the cloud is temporarily unavailable.
    void this.refreshAll();
    await this.discover();
    if (this.stopped) return;
    this.discoveryTimer = setInterval(() => this.discover().catch(error => this.debug(error.message)), this.config.discoveryInterval * 1000);
    this.discoveryTimer.unref?.();
  }

  async discover() {
    if (this.discovering || this.stopped) return;
    this.discovering = true;
    try {
      const result = await this.cloud.discover((id, error) => this.log.warn(`Could not refresh LEDVANCE ${id}: ${error.message}`));
      if (this.stopped) return;
      let supported = 0;
      for (const incoming of result.devices) {
        let device = this.devices.get(incoming.id);
        if (device) {
          // Discovery refreshes names, schemas and local keys without replacing
          // the newer state already confirmed by a command or LAN poll.
          const dps = device.dps;
          Object.assign(device, incoming, { dps });
        } else {
          device = { ...incoming, lastSeen: incoming.online && Object.keys(incoming.dps).length ? Date.now() : 0,
            lastCloudPoll: 0, localRetryAt: 0 };
          this.devices.set(device.id, device);
        }
        const address = this.local.address(device, this.options(device.id));
        if (address) { device.lanIp = address.ip; device.lanVersion = address.version; }
        if (this.attach(device)) supported++;
      }
      this.saveDevices();
      this.log.info(`LEDVANCE discovery: ${result.present.size} device(s) found, ${supported} supported and enabled.`);
      // An incomplete API response never removes HomeKit accessories.
      void this.refreshAll();
    } catch (error) {
      this.log.warn(`LEDVANCE discovery failed: ${error.message} Cached accessories will be retained.`);
      if (!this.retryTimer && !this.stopped) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.discover(); }, 60000);
        this.retryTimer.unref?.();
      }
    } finally { this.discovering = false; }
  }

  attach(device) {
    const options = this.options(device.id);
    if (options.exclude) return false;
    const descriptor = describe(device, options);
    if (descriptor.type === 'unsupported' || (descriptor.type === 'light' && !descriptor.power && !descriptor.mixed)) {
      this.log.warn(`Skipping unsupported LEDVANCE device "${device.name}" (ID ${device.id}, product ${device.productId || 'unknown'}).`);
      this.debug(`Schema codes: ${[...descriptor.map.keys()].join(', ')}`);
      return false;
    }
    let accessory = this.accessories.get(device.id);
    if (!accessory) {
      const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${this.config.region}:${this.config.email.toLowerCase()}:${device.id}`);
      accessory = new this.api.platformAccessory(options.name || device.name, uuid);
      accessory.context.deviceId = device.id;
      this.accessories.set(device.id, accessory);
      // Services must exist before Homebridge registers the accessory.
      const controller = new DeviceAccessory(this, accessory, device, descriptor, options);
      this.controllers.set(device.id, controller);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added "${options.name || device.name}" (${descriptor.type}, ID ${device.id}).`);
    } else {
      const controller = this.controllers.get(device.id);
      if (controller) controller.reconfigure(descriptor, options);
      else this.controllers.set(device.id, new DeviceAccessory(this, accessory, device, descriptor, options));
    }
    this.api.updatePlatformAccessories([accessory]);
    return true;
  }

  lock(id, work) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (this.stopped) throw new Error('Homebridge is stopping.');
      return work();
    });
    const settled = next.catch(() => {});
    this.locks.set(id, settled);
    void settled.then(() => { if (this.locks.get(id) === settled) this.locks.delete(id); });
    return next;
  }
  isAvailable(device) { return !!device.lastSeen && Date.now() - device.lastSeen < this.config.offlineGrace * 1000; }
  accept(device, dps, source) {
    device.dps = { ...device.dps, ...dps }; device.lastSeen = Date.now(); device.lastSource = source;
    device.revision = (device.revision || 0) + 1;
    if (source === 'LAN') device.localRetryAt = 0;
    this.controllers.get(device.id)?.update();
    this.saveDevices();
  }
  async write(id, builder) {
    return this.lock(id, async () => {
      const device = this.devices.get(id);
      if (!device) throw new Error('LEDVANCE device is not discovered yet.');
      const patch = typeof builder === 'function' ? builder(device) : builder;
      if (!patch || !Object.keys(patch).length) throw new Error('This device does not provide the requested control.');
      let source = 'cloud';
      try { await this.local.transact(device, this.options(id), patch); source = 'LAN'; }
      catch { await this.cloud.setDps(device, patch); }
      if (this.stopped) return;
      device.lastWrite = Date.now(); device.writePatch = patch;
      this.accept(device, patch, source);
      this.debug(`${device.name}: command accepted via ${source}`);
    });
  }
  async refreshAll() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      for (const device of this.devices.values()) {
        if (this.stopped) break;
        if (this.options(device.id).exclude || !this.controllers.has(device.id)) continue;
        const now = Date.now();
        let localSuccess = false;
        // Only LAN socket access needs the device lock. A cloud poll must not
        // hold up a HomeKit write while waiting for the remote server.
        if (now >= (device.localRetryAt || 0)) {
          await this.lock(device.id, async () => {
            try {
              const dps = await this.local.transact(device, this.options(device.id));
              if (!this.stopped) this.accept(device, dps, 'LAN');
              localSuccess = true;
            } catch { device.localRetryAt = now + 30000; }
          }).catch(error => this.debug(error.message));
        }
        if (!localSuccess && !this.stopped && now - (device.lastCloudPoll || 0) >= this.config.pollInterval * 1000) {
          device.lastCloudPoll = now;
          const revision = device.revision || 0;
          try {
            const { normalizeDevice } = require('./cloud');
            const current = normalizeDevice(await this.cloud.request('tuya.m.device.get', { devId: device.id }));
            if (this.stopped) return;
            device.online = current.online;
            if (current.localKey) device.localKey = current.localKey;
            if (current.online) {
              let dps = Object.keys(current.dps).length ? current.dps : await this.cloud.getDps(device.id);
              // Skip a response issued before a newer confirmed command.
              if (!this.stopped && (device.revision || 0) === revision) {
                if (Date.now() - (device.lastWrite || 0) < 3000) dps = { ...dps, ...device.writePatch };
                this.accept(device, dps, 'cloud');
              }
            }
          } catch (error) { this.debug(`${device.name}: refresh failed (${error.message})`); }
        }
        if (!this.stopped) this.controllers.get(device.id)?.update();
      }
    } finally { this.refreshing = false; }
  }
  saveDevices() {
    if (this.stopped) return;
    this.store.update({ devices: [...this.devices.values()].map(d => ({ id: d.id, gatewayId: d.gatewayId,
      name: d.name, productId: d.productId, schema: d.schema, dps: d.dps, localKey: d.localKey,
      firmware: d.firmware, mac: d.mac, lanIp: d.lanIp, lanVersion: d.lanVersion })) });
  }
  shutdown() {
    if (this.stopped) return;
    this.saveDevices(); this.stopped = true;
    for (const timer of [this.pollTimer, this.discoveryTimer, this.retryTimer]) clearTimeout(timer);
    for (const controller of this.controllers.values()) controller.shutdown();
    this.local.shutdown(); this.cloud.shutdown(); this.store.close();
  }
}

module.exports = { LedvancePlatform, PLUGIN_NAME, PLATFORM_NAME, normalizeConfig };
