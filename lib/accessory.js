'use strict';

const { bool, property, lightState, lightPatch } = require('./model');

class DeviceAccessory {
  constructor(platform, accessory, device, descriptor, options) {
    this.platform = platform; this.accessory = accessory; this.device = device;
    this.pending = new Map(); this.bindings = [];
    this.reconfigure(descriptor, options);
  }
  failure() { return new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  value(read) {
    if (!this.platform.isAvailable(this.device)) throw this.failure();
    const value = read();
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) throw this.failure();
    return value;
  }
  reconfigure(descriptor, options) {
    this.descriptor = descriptor; this.options = options;
    const { Service: S, Characteristic: C } = this.platform.hap;
    this.name = String(options.name || this.device.name).slice(0, 64);
    this.accessory.displayName = this.name;
    const info = this.accessory.getService(S.AccessoryInformation) || this.accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, this.platform.config.region === 'US (Sylvania app)' ? 'Sylvania' : 'LEDVANCE')
      .setCharacteristic(C.Model, this.device.productId || 'SMART+ WiFi')
      .setCharacteristic(C.SerialNumber, this.device.id)
      .setCharacteristic(C.FirmwareRevision, this.device.firmware || '1.0.0')
      .setCharacteristic(C.Name, this.name);
    this.wanted = new Set([info]); this.bindings = [];
    if (descriptor.type === 'light') {
      if (descriptor.mixed) {
        this.light('white', `${this.name} Main light`);
        this.light('colour', `${this.name} Secondary light`);
        if (this.platform.config.exposeMaster) this.light('combined', `${this.name} All lights`);
      } else this.light('normal', this.name);
      if (this.platform.config.exposeEffects && descriptor.mode && descriptor.effects.length) this.effects();
    } else this.outlets();
    if (this.platform.config.exposeChildLock && descriptor.childLock) {
      const lock = this.service(S.Switch, 'child-lock', `${this.name} Child Lock`);
      this.bind(lock, C.On, () => this.readBool(descriptor.childLock.id),
        value => this.platform.write(this.device.id, { [descriptor.childLock.id]: !!value }));
    }
    for (const service of [...this.accessory.services]) {
      if (!this.wanted.has(service)) this.accessory.removeService(service);
    }
    this.update();
  }
  service(Type, subtype, name) {
    const service = this.accessory.getServiceById(Type, subtype) || this.accessory.addService(Type, name.slice(0, 64), subtype);
    const { Characteristic: C } = this.platform.hap;
    service.setCharacteristic(C.Name, name.slice(0, 64));
    if (C.ConfiguredName) {
      if (!service.testCharacteristic(C.ConfiguredName) && !service.optionalCharacteristics.some(c => c.UUID === C.ConfiguredName.UUID)) {
        service.addOptionalCharacteristic(C.ConfiguredName);
      }
      service.setCharacteristic(C.ConfiguredName, name.slice(0, 64));
    }
    this.wanted.add(service);
    return service;
  }
  bind(service, Type, read, write, props) {
    if (!service.testCharacteristic(Type) && !service.optionalCharacteristics.some(c => c.UUID === Type.UUID)) {
      service.addOptionalCharacteristic(Type);
    }
    const characteristic = service.getCharacteristic(Type);
    if (props) {
      // HAP's initial colour-temperature default can be below a lamp's minimum.
      if (typeof characteristic.value === 'number') {
        characteristic.value = Math.max(props.minValue ?? -Infinity, Math.min(props.maxValue ?? Infinity, characteristic.value));
      }
      characteristic.setProps(props);
    }
    characteristic.onGet(() => this.value(read));
    if (write) characteristic.onSet(async value => {
      try { await write(value); }
      catch (error) {
        this.platform.log.warn(`${this.name}: command failed (${error.message}).`);
        throw this.failure();
      }
    });
    this.bindings.push({ characteristic, read });
    return characteristic;
  }
  readBool(id) { return this.device.dps[id] === undefined ? null : bool(this.device.dps[id]); }

  light(channel, name) {
    const { Service: S, Characteristic: C } = this.platform.hap;
    const d = this.descriptor, service = this.service(S.Lightbulb, `light:${channel}`, name);
    const read = field => () => lightState(this.device, this.descriptor, channel)?.[field];
    const write = field => value => this.queueLight(channel, { [field]: value });
    this.bind(service, C.On, read('on'), write('on'));
    const brightness = channel !== 'combined' && (d.mixed || d.bright || d.colour);
    const colour = channel === 'colour' || (channel === 'normal' && d.colour);
    const temperature = channel === 'white' || (channel === 'normal' && d.temp);
    if (brightness) this.bind(service, C.Brightness, read('brightness'), write('brightness'));
    else if (service.testCharacteristic(C.Brightness)) service.removeCharacteristic(service.getCharacteristic(C.Brightness));
    if (colour) {
      this.bind(service, C.Hue, read('hue'), write('hue'));
      this.bind(service, C.Saturation, read('saturation'), write('saturation'));
    } else {
      for (const Type of [C.Hue, C.Saturation]) if (service.testCharacteristic(Type)) service.removeCharacteristic(service.getCharacteristic(Type));
    }
    if (temperature) this.bind(service, C.ColorTemperature, read('temperature'), write('temperature'), {
      minValue: d.miredMin, maxValue: d.miredMax, minStep: 1,
    });
    else if (service.testCharacteristic(C.ColorTemperature)) service.removeCharacteristic(service.getCharacteristic(C.ColorTemperature));
    if (channel === 'normal' || channel === 'white') service.setPrimaryService(true);
  }
  queueLight(channel, values) {
    if (this.platform.stopped) return Promise.reject(new Error('Homebridge is stopping.'));
    return new Promise((resolve, reject) => {
      let batch = this.pending.get(channel);
      if (!batch) {
        batch = { values: {}, callbacks: [] };
        this.pending.set(channel, batch);
        batch.timer = setTimeout(() => {
          this.pending.delete(channel);
          this.platform.write(this.device.id, device => lightPatch(device, this.descriptor, channel, batch.values))
            .then(() => batch.callbacks.forEach(c => c.resolve()), error => batch.callbacks.forEach(c => c.reject(error)));
        }, 120);
      }
      Object.assign(batch.values, values);
      batch.callbacks.push({ resolve, reject });
    });
  }
  outlets() {
    const { Service: S, Characteristic: C } = this.platform.hap;
    const d = this.descriptor, Type = d.type === 'switch' ? S.Switch : S.Outlet;
    let first;
    for (const outlet of d.outlets) {
      const label = d.outlets.length === 1 ? this.name : `${this.name} ${outlet.label}`;
      const service = this.service(Type, `outlet:${outlet.id}`, label);
      if (!first) { first = service; service.setPrimaryService(true); }
      this.bind(service, C.On, () => this.readBool(outlet.id), value => this.platform.write(this.device.id, { [outlet.id]: !!value }));
      if (Type === S.Outlet) this.bind(service, C.OutletInUse, () => this.readBool(outlet.id));
      const fault = d.map.get('fault');
      if (fault) this.bind(service, C.StatusFault, () => this.device.dps[fault.id] === undefined ? null : Number(this.device.dps[fault.id]) !== 0 ? 1 : 0);
    }
    if (d.outlets.length > 1 && this.platform.config.exposeMaster) {
      const service = this.service(S.Switch, 'all-outlets', `${this.name} All Outlets`);
      this.bind(service, C.On, () => d.master ? this.readBool(d.master.id) :
        d.outlets.some(o => this.device.dps[o.id] !== undefined) ? d.outlets.some(o => bool(this.device.dps[o.id])) : null,
      value => this.platform.write(this.device.id, d.master ? { [d.master.id]: !!value } :
        Object.fromEntries(d.outlets.map(o => [o.id, !!value]))));
    }
    if (first && this.platform.config.exposePower) this.power(first);
  }
  power(service) {
    const { Characteristic, Formats, Perms } = this.platform.hap;
    const definitions = [
      { code: 'cur_voltage', name: 'Voltage', short: '10A', unit: 'V', divisor: 10, max: 1000 },
      { code: 'cur_current', name: 'Electric Current', short: '126', unit: 'A', divisor: 1000, max: 1000 },
      { code: 'cur_power', name: 'Current Consumption', short: '10D', unit: 'W', divisor: 10, max: 100000 },
      { code: 'total_forward_energy', name: 'Total Consumption', short: '10C', unit: 'kWh', divisor: 1000, max: 1e9 },
    ];
    for (const definition of definitions) {
      const item = this.descriptor.map.get(definition.code);
      if (!item) continue;
      const uuid = `E863F${definition.short}-079E-48FF-8F27-9C2605A29F52`;
      class PowerCharacteristic extends Characteristic {
        static UUID = uuid;
        constructor() {
          super(definition.name, uuid);
          this.setProps({ format: Formats.FLOAT, unit: definition.unit, minValue: 0, maxValue: definition.max,
            minStep: 0.001, perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
          this.value = this.getDefaultValue();
        }
      }
      const props = property(item);
      const divisor = Number(props.scale) > 0 ? 10 ** Number(props.scale) : definition.divisor;
      this.bind(service, PowerCharacteristic, () => {
        const raw = this.device.dps[item.id];
        return raw === undefined || raw === null ? null : Number(raw) / divisor;
      });
    }
  }
  effects() {
    const { Service: S, Characteristic: C } = this.platform.hap;
    const d = this.descriptor;
    for (const effect of d.effects) {
      const service = this.service(S.Switch, `effect:${effect}`, `${this.name} ${effect}`);
      this.bind(service, C.On, () => this.device.dps[d.mode.id] === effect,
        value => this.platform.write(this.device.id, device => {
          if (value) this.previousMode = device.dps[d.mode.id];
          const normal = this.previousMode && !d.effects.includes(this.previousMode) ? this.previousMode : d.bright || d.temp ? 'white' : 'colour';
          return { [d.mode.id]: value ? effect : normal, ...(value && d.power ? { [d.power.id]: true } : {}) };
        }));
    }
  }
  update() {
    for (const { characteristic, read } of this.bindings) {
      try { characteristic.updateValue(this.value(read)); }
      catch { characteristic.updateValue(this.failure()); }
    }
  }
  shutdown() {
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
      batch.callbacks.forEach(c => c.reject(new Error('Homebridge is stopping.')));
    }
    this.pending.clear();
  }
}

module.exports = { DeviceAccessory };
