'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const hap = require('@homebridge/hap-nodejs');
const { PlatformAccessory } = require(path.join(path.dirname(require.resolve('homebridge')), 'platformAccessory.js'));
const { LedvancePlatform, normalizeConfig } = require('../lib/platform');
const { decodeMixed } = require('../lib/model');
const vectors = require('./fixtures/protocol.json');

function device(overrides = {}) {
  return { id: 'dev-1', gatewayId: 'dev-1', name: 'Test Light', productId: 'product', firmware: '1.2.3',
    lastSeen: Date.now(), online: true, localKey: '0123456789abcdef',
    dps: { 20: true, 21: 'colour', 22: 800, 23: 500, 24: '007802bc033f' },
    schema: [{ id: 20, code: 'switch_led' }, { id: 21, code: 'work_mode', property: { range: ['white', 'colour', 'scene'] } },
      { id: 22, code: 'bright_value_v2', property: { min: 10, max: 1000 } },
      { id: 23, code: 'temp_value', property: { min: 0, max: 1000 } }, { id: 24, code: 'colour_data_v2' }],
    ...overrides };
}
function harness(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledvance-test-'));
  const messages = [], registered = [], removed = [], writes = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, text => messages.push({ level, text })]));
  const api = new EventEmitter();
  Object.assign(api, { hap, platformAccessory: PlatformAccessory, user: { storagePath: () => folder },
    updatePlatformAccessories: () => {},
    registerPlatformAccessories: (plugin, platform, accessories) => {
      for (const accessory of accessories) {
        assert.ok(accessory.services.length > 1, 'services must exist before registration');
        accessory._associatedPlugin = plugin;
        accessory._associatedPlatform = platform;
      }
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: (plugin, platform, accessories) => removed.push(...accessories) });
  const platform = new LedvancePlatform(log, { email: 'test@example.com', password: 'test', localControl: false, ...options }, api);
  platform.local.transact = async () => { throw new Error('LAN_UNAVAILABLE'); };
  platform.cloud.setDps = async (dev, dps) => { writes.push({ id: dev.id, dps }); return true; };
  t.after(() => { platform.shutdown(); fs.rmSync(folder, { recursive: true, force: true }); });
  const attach = dev => { platform.devices.set(dev.id, dev); assert.ok(platform.attach(dev)); return platform.accessories.get(dev.id); };
  return { platform, api, messages, registered, removed, writes, folder, attach };
}

test('real Homebridge API registration uses the published plugin identity', () => {
  let called;
  require('../index')({ registerPlatform: (...args) => { called = args; } });
  assert.equal(called[0], 'homebridge-ledvance-native');
  assert.equal(called[1], 'LedvanceNative');
  assert.equal(called[2], LedvancePlatform);
});
test('Homebridge UI schema validates the complete example and keeps optional devices empty', () => {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strict: false }); ajv.addFormat('password', true);
  const schema = require('../config.schema.json');
  const validate = ajv.compile(schema.schema);
  assert.equal(validate(require('../config.example.json')), true, JSON.stringify(validate.errors));
  assert.deepEqual(schema.schema.properties.devices.default, []);
  assert.deepEqual(normalizeConfig({ devices: [{ exclude: false }, {}, { id: '' }] }).devices, []);
});
test('RGB light registers real HAP controls, names, serial and firmware', t => {
  const h = harness(t), dev = device(), accessory = h.attach(dev);
  const service = accessory.getService(hap.Service.Lightbulb);
  for (const Type of [hap.Characteristic.On, hap.Characteristic.Brightness, hap.Characteristic.Hue,
    hap.Characteristic.Saturation, hap.Characteristic.ColorTemperature]) assert.ok(service.testCharacteristic(Type));
  assert.equal(accessory.getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.SerialNumber).value, 'dev-1');
  assert.equal(service.getCharacteristic(hap.Characteristic.Brightness).value, 83);
  assert.equal(h.registered.length, 1);
});
test('simultaneous HomeKit hue/saturation writes produce one command without losing brightness', async t => {
  const h = harness(t), accessory = h.attach(device());
  const service = accessory.getService(hap.Service.Lightbulb);
  await Promise.all([
    service.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(240),
    service.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(40),
  ]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].dps[24], '00f00190033f');
  assert.equal(await service.getCharacteristic(hap.Characteristic.On).handleGetRequest(), true);
});
test('failed commands return a HomeKit communication error and retain confirmed state', async t => {
  const h = harness(t), dev = device(), accessory = h.attach(dev);
  h.platform.cloud.setDps = async () => { throw new Error('command rejected'); };
  const on = accessory.getService(hap.Service.Lightbulb).getCharacteristic(hap.Characteristic.On);
  await assert.rejects(on.handleSetRequest(false));
  assert.equal(dev.dps[20], true);
  assert.equal(await on.handleGetRequest(), true);
});
test('mixed lamps expose three real Lightbulb services with independent controls', async t => {
  const h = harness(t), dev = device(); dev.schema.push({ id: 51, code: 'mix_rgbcw' }); dev.dps[51] = vectors.mixed.encoded;
  const accessory = h.attach(dev), white = accessory.getServiceById(hap.Service.Lightbulb, 'light:white');
  const colour = accessory.getServiceById(hap.Service.Lightbulb, 'light:colour');
  assert.equal(accessory.services.filter(s => s.UUID === hap.Service.Lightbulb.UUID).length, 3);
  assert.ok(white.testCharacteristic(hap.Characteristic.ColorTemperature));
  assert.ok(!white.testCharacteristic(hap.Characteristic.Hue));
  assert.ok(colour.testCharacteristic(hap.Characteristic.Hue));
  await Promise.all([
    white.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(25),
    colour.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(220),
  ]);
  const state = decodeMixed(dev.dps[51]);
  assert.equal(state.h, 220);
  assert.equal(state.b, 250);
  assert.equal(state.v, 250);
  assert.equal(h.writes.length, 2);
});
test('power strip exposes outlets, USB, synthetic master and optional child lock', async t => {
  const h = harness(t, { exposeChildLock: true });
  const dev = device({ name: 'Power Strip', dps: { 1: true, 2: false, 3: true, 4: false }, schema: [
    { id: 1, code: 'switch_1' }, { id: 2, code: 'switch_2' }, { id: 3, code: 'usb_switch' }, { id: 4, code: 'child_lock' },
  ] });
  const accessory = h.attach(dev);
  assert.equal(accessory.services.filter(s => s.UUID === hap.Service.Outlet.UUID).length, 3);
  const master = accessory.getServiceById(hap.Service.Switch, 'all-outlets').getCharacteristic(hap.Characteristic.On);
  assert.equal(await master.handleGetRequest(), true);
  await master.handleSetRequest(false);
  assert.deepEqual(h.writes[0].dps, { 1: false, 2: false, 3: false });
  const lock = accessory.getServiceById(hap.Service.Switch, 'child-lock').getCharacteristic(hap.Characteristic.On);
  await lock.handleSetRequest(true);
  assert.deepEqual(h.writes[1].dps, { 4: true });
});
test('single plugs are Outlets and can be explicitly configured as Switches', t => {
  const h = harness(t, { devices: [{ id: 'dev-1', type: 'switch' }] });
  const accessory = h.attach(device({ schema: [{ code: 'switch_1', id: 1 }], dps: { 1: true } }));
  assert.ok(accessory.getService(hap.Service.Switch));
  assert.equal(accessory.getService(hap.Service.Outlet), undefined);
});
test('supported power measurements have Eve UUIDs and scaled values', t => {
  const h = harness(t);
  const accessory = h.attach(device({ schema: [{ id: 1, code: 'switch_1' },
    { id: 19, code: 'cur_power', property: { scale: 1 } }, { id: 20, code: 'cur_voltage', property: { scale: 1 } }],
  dps: { 1: true, 19: 123, 20: 2301 } }));
  const service = accessory.getService(hap.Service.Outlet);
  assert.equal(service.characteristics.find(c => c.UUID === 'E863F10D-079E-48FF-8F27-9C2605A29F52').value, 12.3);
  assert.equal(service.characteristics.find(c => c.UUID === 'E863F10A-079E-48FF-8F27-9C2605A29F52').value, 230.1);
});
test('short polling failures retain availability; prolonged failures become No Response', async t => {
  const h = harness(t), dev = device(), accessory = h.attach(dev);
  h.platform.cloud.request = async () => { throw new Error('offline'); };
  await h.platform.refreshAll();
  const on = accessory.getService(hap.Service.Lightbulb).getCharacteristic(hap.Characteristic.On);
  assert.equal(await on.handleGetRequest(), true);
  dev.lastSeen = Date.now() - 121000;
  h.platform.controllers.get(dev.id).update();
  await assert.rejects(on.handleGetRequest());
  h.platform.accept(dev, { 20: false }, 'LAN');
  assert.equal(await on.handleGetRequest(), false);
});
test('local command failure falls back once to cloud; local success avoids cloud', async t => {
  const h = harness(t), dev = device(); h.attach(dev);
  await h.platform.write(dev.id, { 20: false });
  assert.equal(h.writes.length, 1);
  h.platform.local.transact = async () => true;
  await h.platform.write(dev.id, { 20: true });
  assert.equal(h.writes.length, 1);
  assert.equal(dev.lastSource, 'LAN');
});
test('fresh local states remain usable when the cloud reports offline', async t => {
  const h = harness(t), dev = device({ online: false }); h.attach(dev);
  h.platform.local.transact = async () => ({ 20: false });
  await h.platform.refreshAll();
  assert.equal(h.platform.isAvailable(dev), true);
  assert.equal(dev.dps[20], false);
});
test('discovery errors and absent devices never unregister cached accessories', async t => {
  const h = harness(t); h.attach(device());
  h.platform.cloud.discover = async () => { throw new Error('temporary outage'); };
  await h.platform.discover();
  h.platform.cloud.discover = async () => ({ devices: [], present: new Set() });
  await h.platform.discover();
  assert.equal(h.removed.length, 0);
  assert.equal(h.platform.accessories.size, 1);
});
test('discovery refreshes keys without overwriting newer command state', async t => {
  const h = harness(t), dev = device(); h.attach(dev);
  h.platform.refreshAll = async () => {};
  dev.dps[20] = false;
  h.platform.cloud.discover = async () => ({ devices: [device({ localKey: 'newkey0123456789x' })], present: new Set(['dev-1']) });
  await h.platform.discover();
  assert.equal(dev.dps[20], false);
  assert.equal(dev.localKey, 'newkey0123456789x');
});
test('a slow cloud poll neither blocks a command nor overwrites its confirmed state', async t => {
  const h = harness(t), dev = device(); h.attach(dev);
  let finishPoll, beginPoll;
  const begun = new Promise(resolve => { beginPoll = resolve; });
  h.platform.cloud.request = async () => {
    beginPoll();
    return new Promise(resolve => { finishPoll = resolve; });
  };
  const poll = h.platform.refreshAll(); await begun;
  await h.platform.write(dev.id, { 20: false });
  assert.equal(dev.dps[20], false);
  finishPoll({ devId: dev.id, isOnline: true, schema: [], dps: { 20: true } });
  await poll;
  assert.equal(dev.dps[20], false);
  assert.equal(h.writes.length, 1);
});
test('cache permissions are private and passwords are not written to it', t => {
  const h = harness(t); h.attach(device());
  h.platform.store.update({ tokens: { sid: 'session', refreshToken: 'refresh' } });
  h.platform.saveDevices(); h.platform.store.flush();
  assert.equal(fs.statSync(h.platform.store.file).mode & 0o777, 0o600);
  const cache = fs.readFileSync(h.platform.store.file, 'utf8');
  assert.ok(cache.includes('session'));
  assert.ok(!cache.includes('"password"'));
  const rawContext = JSON.stringify(h.platform.accessories.get('dev-1').context);
  assert.equal(rawContext, '{"deviceId":"dev-1"}');
});
test('reloading a cached accessory keeps UUID and service IDs', t => {
  const h = harness(t), dev = device(), original = h.attach(dev);
  const serialized = PlatformAccessory.serialize(original);
  const restored = PlatformAccessory.deserialize(serialized);
  h.platform.controllers.clear(); h.platform.accessories.clear();
  h.platform.configureAccessory(restored); h.platform.attach(dev);
  assert.equal(h.platform.accessories.get(dev.id).UUID, original.UUID);
  assert.equal(h.registered.length, 1);
  assert.equal(restored.getService(hap.Service.Lightbulb).subtype, 'light:normal');
});
test('disabled optional controls are removed from cached services on reconfigure', t => {
  const h = harness(t, { exposeEffects: true }), dev = device();
  const accessory = h.attach(dev);
  assert.ok(accessory.getServiceById(hap.Service.Switch, 'effect:scene'));
  h.platform.config.exposeEffects = false;
  h.platform.attach(dev);
  assert.equal(accessory.getServiceById(hap.Service.Switch, 'effect:scene'), undefined);
});
test('shutdown rejects queued light writes and prevents commands after shutdown', async t => {
  const h = harness(t); h.attach(device());
  const pending = h.platform.controllers.get('dev-1').queueLight('normal', { on: false });
  h.platform.shutdown();
  await assert.rejects(pending, /stopping/);
  await assert.rejects(h.platform.write('dev-1', { 20: true }), /stopping/);
});
