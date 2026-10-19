'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const hex = (n, width) => Math.round(n).toString(16).padStart(width, '0');
const bool = value => value === true || value === 1 || value === 'true' || value === '1';

function property(item) {
  try { return typeof item?.property === 'string' ? JSON.parse(item.property) : (item?.property || {}); }
  catch { return {}; }
}
function writable(item) { return !item.mode || item.mode.includes('w'); }
function describe(device, options = {}) {
  const schema = Array.isArray(device.schema) ? device.schema : [];
  const map = new Map(schema.filter(i => i.code && i.id !== undefined).map(i => [i.code, { ...i, id: String(i.id) }]));
  const pick = (...codes) => codes.map(c => map.get(c)).find(Boolean);
  const mixed = pick('mix_rgbcw');
  const colour = pick('colour_data_v2', 'colour_data');
  const bright = pick('bright_value_v2', 'bright_value');
  const temp = pick('temp_value_v2', 'temp_value');
  const mode = pick('work_mode');
  const power = pick('switch_led', 'switch', 'switch_1');
  const light = !!(mixed || colour || bright || temp || map.has('switch_led'));
  const outlets = schema.filter(i => writable(i) && /^(switch_\d+|usb_switch|switch_usb\d+)$/.test(i.code || ''))
    .map(i => ({ id: String(i.id), code: i.code, label: i.code === 'usb_switch' ? 'USB' :
      i.code.startsWith('switch_usb') ? `USB ${i.code.slice(10)}` : `Outlet ${i.code.slice(7)}` }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  if (!outlets.length && power && writable(power)) outlets.push({ ...power, label: '' });
  if (!outlets.length && device.productId === 'pq860vo9ib50jhud' && typeof device.dps?.['1'] === 'boolean') {
    outlets.push({ id: '1', code: 'switch_1', label: '' });
  }
  const explicit = options.type && options.type !== 'auto' ? options.type : null;
  const type = explicit || (light ? 'light' : outlets.length ? 'outlet' : 'unsupported');
  const minKelvin = clamp(options.minKelvin || 2000, 1000, 10000);
  const maxKelvin = Math.max(minKelvin + 1, clamp(options.maxKelvin || 6536, 1001, 12000));
  const range = (item, fallback) => {
    const p = property(item);
    const lo = Number(p.min ?? fallback[0]), hi = Number(p.max ?? fallback[1]);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : fallback;
  };
  return { type, map, mixed, colour, bright, temp, mode, power, outlets, minKelvin, maxKelvin,
    miredMin: Math.ceil(1000000 / maxKelvin), miredMax: Math.floor(1000000 / minKelvin),
    brightRange: range(bright, bright?.code === 'bright_value' ? [25, 255] : [10, 1000]),
    tempRange: range(temp, [0, 1000]), master: pick('master_switch', 'switch_all'),
    childLock: pick('child_lock'),
    effects: (property(mode).range || []).filter(m => !['white', 'colour', 'color'].includes(m)),
  };
}

function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360 / 60;
  const c = v * s / 100, x = c * (1 - Math.abs(hue % 2 - 1)), m = v - c;
  const palette = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  return palette[Math.floor(hue)].map(n => Math.round((n + m) * 255));
}
function rgbToHsv(rgb) {
  const [r, g, b] = rgb.map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) h = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  return { h: (h + 360) % 360, s: max ? delta / max * 100 : 0, v: max };
}
function decodeColour(raw) {
  if (typeof raw === 'string' && /^[0-9a-f]+$/i.test(raw)) {
    if (raw.length === 6) return { ...rgbToHsv([0, 2, 4].map(i => parseInt(raw.slice(i, i + 2), 16))), format: 'rgb' };
    if (raw.length === 12) {
      const [h, s, v] = [0, 4, 8].map(i => parseInt(raw.slice(i, i + 4), 16));
      if (h <= 360 && s <= 1000 && v <= 1000) return { h, s: s / 10, v: v / 1000, format: 'hsv' };
    }
    if (raw.length === 14) {
      const h = parseInt(raw.slice(6, 10), 16), s = parseInt(raw.slice(10, 12), 16), v = parseInt(raw.slice(12, 14), 16);
      if (h <= 360) return { h, s: s / 255 * 100, v: v / 255, format: 'rgbhsv' };
    }
  }
  let data = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { return null; } }
  if (data && typeof data === 'object' && [data.h, data.s, data.v].every(Number.isFinite)) {
    return { h: clamp(data.h, 0, 360), s: clamp(data.s, 0, 1000) / 10, v: clamp(data.v, 0, 1000) / 1000,
      format: typeof raw === 'string' ? 'json' : 'object' };
  }
  return null;
}
function encodeColour({ h, s, v, format = 'hsv' }) {
  h = clamp(h, 0, 360); s = clamp(s, 0, 100); v = clamp(v, 0, 1);
  const rgb = () => hsvToRgb(h, s, v).map(n => hex(n, 2)).join('');
  if (format === 'rgb') return rgb();
  if (format === 'rgbhsv') return rgb() + hex(h, 4) + hex(s / 100 * 255, 2) + hex(v * 255, 2);
  if (format === 'json' || format === 'object') {
    const data = { h: Math.round(h), s: Math.round(s * 10), v: Math.round(v * 1000) };
    return format === 'json' ? JSON.stringify(data) : data;
  }
  return hex(h, 4) + hex(s * 10, 4) + hex(v * 1000, 4);
}
function decodeMixed(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(raw)) return null;
  const data = Buffer.from(raw, 'base64');
  if (data.length !== 12 || data[0] !== 0 || (data[1] & ~7)) return null;
  const numbers = [2, 4, 6, 8, 10].map(i => data.readUInt16BE(i));
  if (numbers[0] > 360 || numbers.slice(1).some(n => n > 1000)) return null;
  const [h, s, v, b, t] = numbers;
  return { flags: data[1], h, s, v, b, t };
}
function encodeMixed(state) {
  const data = Buffer.alloc(12); data[1] = state.flags;
  [state.h, state.s, state.v, state.b, state.t].forEach((n, i) => data.writeUInt16BE(Math.round(n), 2 + i * 2));
  const encoded = data.toString('base64');
  if (!decodeMixed(encoded)) throw new Error('Invalid mixed-light state');
  return encoded;
}
function toPercent(n, [lo, hi]) { return Math.round(1 + clamp((Number(n) - lo) / (hi - lo), 0, 1) * 99); }
function fromPercent(n, [lo, hi]) { return Math.round(lo + (clamp(n, 1, 100) - 1) / 99 * (hi - lo)); }
function tempToMired(raw, d) {
  const [lo, hi] = d.tempRange;
  const k = d.minKelvin + clamp((Number(raw ?? lo) - lo) / (hi - lo), 0, 1) * (d.maxKelvin - d.minKelvin);
  return Math.round(clamp(1000000 / k, d.miredMin, d.miredMax));
}
function miredToTemp(value, d) {
  const k = 1000000 / clamp(value, d.miredMin, d.miredMax), [lo, hi] = d.tempRange;
  return Math.round(lo + clamp((k - d.minKelvin) / (d.maxKelvin - d.minKelvin), 0, 1) * (hi - lo));
}
function lightState(device, d, channel = 'normal') {
  if (d.power && device.dps[d.power.id] === undefined) return null;
  if (d.mixed) {
    const state = decodeMixed(device.dps[d.mixed.id]);
    if (!state) return null;
    const mask = channel === 'white' ? 1 : channel === 'colour' ? 2 : 3;
    return { on: (!d.power || bool(device.dps[d.power.id])) && !!(state.flags & mask),
      brightness: channel === 'colour' ? toPercent(state.v, [10, 1000]) : toPercent(state.b, [10, 1000]),
      hue: state.h, saturation: state.s / 10,
      temperature: tempToMired(state.t, { ...d, tempRange: [0, 1000] }) };
  }
  const colour = decodeColour(device.dps[d.colour?.id]);
  const colourMode = d.colour && (['colour', 'color'].includes(device.dps[d.mode?.id]) || !d.bright);
  return { on: bool(device.dps[d.power?.id]),
    brightness: colourMode ? Math.round((colour?.v ?? 1) * 100) : toPercent(device.dps[d.bright?.id] ?? d.brightRange[1], d.brightRange),
    hue: colour?.h ?? 0, saturation: colour?.s ?? 0, temperature: tempToMired(device.dps[d.temp?.id], d) };
}

function lightPatch(device, d, channel, values) {
  const patch = {};
  const attributes = ['brightness', 'hue', 'saturation', 'temperature'].some(k => values[k] !== undefined);
  const on = values.on !== undefined ? !!values.on : values.brightness === 0 ? false : attributes ? true : undefined;
  if (d.mixed) {
    const state = decodeMixed(device.dps[d.mixed.id]);
    if (!state) throw new Error('Unsupported or missing mix_rgbcw state; wait for a successful device refresh.');
    const mask = channel === 'white' ? 1 : channel === 'colour' ? 2 : 3;
    if (on !== undefined) state.flags = (on ? state.flags | mask : state.flags & ~mask) | 4;
    if (on && channel !== 'colour' && !state.b) state.b = 1000;
    if (on && channel !== 'white' && !state.v) state.v = 1000;
    if (values.brightness > 0) state[channel === 'colour' ? 'v' : 'b'] = fromPercent(values.brightness, [10, 1000]);
    if (values.hue !== undefined) state.h = Math.round(clamp(values.hue, 0, 360));
    if (values.saturation !== undefined) state.s = Math.round(clamp(values.saturation, 0, 100) * 10);
    if (values.temperature !== undefined) state.t = miredToTemp(values.temperature, { ...d, tempRange: [0, 1000] });
    patch[d.mixed.id] = encodeMixed(state);
    if (d.power) patch[d.power.id] = !!(state.flags & 3);
    return patch;
  }
  if (d.power && on !== undefined) patch[d.power.id] = on;
  const wantsColour = d.colour && values.temperature === undefined && (values.hue !== undefined || values.saturation !== undefined ||
    (values.temperature === undefined && (['colour', 'color'].includes(device.dps[d.mode?.id]) || !d.bright)));
  if (wantsColour && attributes) {
    const current = decodeColour(device.dps[d.colour.id]) || { h: 0, s: 0, v: 1, format: d.colour.code === 'colour_data' ? 'rgbhsv' : 'hsv' };
    if (values.hue !== undefined) current.h = values.hue;
    if (values.saturation !== undefined) current.s = values.saturation;
    if (values.brightness > 0) current.v = clamp(values.brightness, 1, 100) / 100;
    patch[d.colour.id] = encodeColour(current);
    if (d.mode) patch[d.mode.id] = 'colour';
  } else if (attributes) {
    if (d.bright && values.brightness > 0) patch[d.bright.id] = fromPercent(values.brightness, d.brightRange);
    if (d.temp && values.temperature !== undefined) patch[d.temp.id] = miredToTemp(values.temperature, d);
    if (d.mode) patch[d.mode.id] = 'white';
  }
  return patch;
}

module.exports = { describe, property, bool, clamp, decodeColour, encodeColour, decodeMixed, encodeMixed,
  lightState, lightPatch, toPercent, fromPercent, tempToMired, miredToTemp };
