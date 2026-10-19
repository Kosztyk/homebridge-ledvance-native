'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/model');
const vectors = require('./fixtures/protocol.json');
const light = () => ({ id: 'light', dps: { 20: true, 21: 'colour', 22: 800, 23: 500, 24: '007802bc033f' }, schema: [
  { id: 20, code: 'switch_led' }, { id: 21, code: 'work_mode', property: { range: ['white', 'colour', 'scene', 'music'] } },
  { id: 22, code: 'bright_value_v2', property: { min: 10, max: 1000 } },
  { id: 23, code: 'temp_value', property: '{"min":0,"max":1000}' }, { id: 24, code: 'colour_data_v2' },
] });

test('schema identifies lights without treating generic work modes as lights', () => {
  assert.equal(m.describe(light()).type, 'light');
  assert.equal(m.describe({ schema: [{ code: 'switch_led', id: 1 }] }).type, 'light');
  assert.equal(m.describe({ schema: [{ code: 'work_mode', id: 2 }] }).type, 'unsupported');
});
test('all numbered outlets and USB channels survive numeric schema IDs', () => {
  const d = m.describe({ schema: ['switch_10', 'switch_2', 'usb_switch', 'switch_usb1', 'child_lock'].map((code, id) => ({ code, id })) });
  assert.equal(d.type, 'outlet');
  assert.deepEqual(d.outlets.map(o => o.label), ['Outlet 2', 'Outlet 10', 'USB 1', 'USB']);
  assert.equal(d.childLock.id, '4');
});
test('schema-declared integer ranges and writable modes are respected', () => {
  const device = light();
  device.schema[2].property = '{"min":25,"max":255}';
  assert.equal(m.lightPatch(device, m.describe(device), 'normal', { temperature: 400, brightness: 50 })['22'], 139);
  assert.equal(m.describe({ schema: [{ code: 'switch_1', id: 1, mode: 'ro' }] }).type, 'unsupported');
});
test('HSV hue/saturation updates preserve exact 0..1000 colour brightness', () => {
  const device = light(), d = m.describe(device);
  const patch = m.lightPatch(device, d, 'normal', { hue: 240, saturation: 40 });
  assert.equal(patch['24'], '00f00190033f');
  assert.equal(patch['21'], 'colour');
  assert.equal(patch['22'], undefined);
});
test('RGB brightness changes target the colour DP and preserve hue/saturation', () => {
  const device = light();
  const patch = m.lightPatch(device, m.describe(device), 'normal', { brightness: 50 });
  assert.equal(patch['24'], '007802bc01f4');
  assert.equal(patch['22'], undefined);
});
test('white brightness changes use the white DP', () => {
  const device = light(); device.dps[21] = 'white';
  const patch = m.lightPatch(device, m.describe(device), 'normal', { brightness: 100 });
  assert.equal(patch['22'], 1000);
  assert.equal(patch['24'], undefined);
});
test('an explicit colour-temperature update takes precedence over batched hue fields', () => {
  const device = light();
  const patch = m.lightPatch(device, m.describe(device), 'normal', { temperature: 350, hue: 0, saturation: 0 });
  assert.equal(patch[21], 'white');
  assert.equal(patch[24], undefined);
  assert.ok(Number.isInteger(patch[23]));
});
test('turning on without attributes preserves the current colour/effect mode', () => {
  const device = light();
  assert.deepEqual(m.lightPatch(device, m.describe(device), 'normal', { on: true }), { 20: true });
});
test('brightness zero sends off; explicit off wins over batched colour changes', () => {
  const device = light(), d = m.describe(device);
  assert.equal(m.lightPatch(device, d, 'normal', { brightness: 0 })[20], false);
  assert.equal(m.lightPatch(device, d, 'normal', { on: false, hue: 90, brightness: 50 })[20], false);
});
test('colour formats include old RGBHSV, RGB-only and JSON HSV', () => {
  for (const raw of ['ff00000000ffff', 'ff0000', '{"h":0,"s":1000,"v":1000}', '000003e803e8']) {
    const state = m.decodeColour(raw);
    assert.ok(state);
    assert.equal(Math.round(state.h), 0);
    assert.equal(Math.round(state.s), 100);
    assert.equal(m.encodeColour(state), raw);
  }
  assert.equal(m.decodeColour('invalid'), null);
  assert.equal(m.decodeColour('ffff03e803e8'), null);
});
test('Tuya temperature direction maps warm to high mireds and cool to low mireds', () => {
  const d = m.describe(light(), { minKelvin: 2000, maxKelvin: 6500 });
  assert.equal(m.tempToMired(0, d), 500);
  assert.equal(m.tempToMired(1000, d), 154);
  assert.equal(m.miredToTemp(500, d), 0);
  assert.ok(m.miredToTemp(154, d) > 995);
});
test('mix_rgbcw codec matches independent Python struct vector', () => {
  assert.deepEqual(m.decodeMixed(vectors.mixed.encoded), vectors.mixed.state);
  assert.equal(m.encodeMixed(vectors.mixed.state), vectors.mixed.encoded);
});
test('mix_rgbcw rejects unsupported versions, malformed lengths, flags and bounds', () => {
  for (const raw of [null, '', 'a', vectors.mixed.encoded + '=', Buffer.alloc(11).toString('base64')]) assert.equal(m.decodeMixed(raw), null);
  for (const [offset, value] of [[0, 1], [1, 8]]) {
    const data = Buffer.from(vectors.mixed.encoded, 'base64'); data[offset] = value;
    assert.equal(m.decodeMixed(data.toString('base64')), null);
  }
  const invalid = Buffer.from(vectors.mixed.encoded, 'base64'); invalid.writeUInt16BE(1001, 4);
  assert.equal(m.decodeMixed(invalid.toString('base64')), null);
});
test('mixed white and RGB commands preserve the other physical channel', () => {
  const device = light(); device.schema.push({ code: 'mix_rgbcw', id: 51 }); device.dps[51] = vectors.mixed.encoded;
  const d = m.describe(device);
  let patch = m.lightPatch(device, d, 'white', { on: false });
  assert.equal(m.decodeMixed(patch[51]).flags, 6);
  assert.equal(m.decodeMixed(patch[51]).v, 250);
  assert.equal(patch[20], true);
  device.dps = { ...device.dps, ...patch };
  patch = m.lightPatch(device, d, 'colour', { hue: 220, brightness: 80 });
  assert.equal(m.decodeMixed(patch[51]).b, 800);
  assert.equal(m.decodeMixed(patch[51]).flags, 6);
  assert.equal(m.decodeMixed(patch[51]).h, 220);
});
test('all-lights off disables both mixed channels and global power', () => {
  const device = light(); device.schema.push({ code: 'mix_rgbcw', id: 51 }); device.dps[51] = vectors.mixed.encoded;
  const patch = m.lightPatch(device, m.describe(device), 'combined', { on: false });
  assert.equal(m.decodeMixed(patch[51]).flags, 4);
  assert.equal(patch[20], false);
});

module.exports = { light };
