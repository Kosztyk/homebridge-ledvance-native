'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const TuyaDevice = require('tuyapi');
const { MessageParser } = require('tuyapi/lib/message-parser');
const { UDP_KEY } = require('tuyapi/lib/config');
const { LocalTransport, parseAdvertisement, discoveryPacket, broadcast } = require('../lib/local');
const config = { localControl: true, localTimeout: 0.6, lanDiscoveryInterval: 300 };
const log = { warn() {} };
const device = { id: 'test-lamp', localKey: '0123456789abcdef', lanIp: '127.0.0.1', lanVersion: '3.3' };

test('broadcast address honours the actual /22 subnet mask', () => {
  assert.equal(broadcast('192.168.68.109', '255.255.252.0'), '192.168.71.255');
  assert.equal(broadcast('192.168.1.5', '255.255.255.0'), '192.168.1.255');
});
test('active discovery uses a valid 6699 GCM packet with REQ_DEVINFO', () => {
  const packet = discoveryPacket('192.168.68.109');
  assert.equal(packet.readUInt32BE(0), 0x6699);
  assert.equal(packet.readUInt32BE(10), 0x25);
  assert.equal(packet.readUInt32BE(packet.length - 4), 0x9966);
  const decipher = crypto.createDecipheriv('aes-128-gcm', UDP_KEY, packet.subarray(18, 30));
  decipher.setAAD(packet.subarray(4, 18));
  decipher.setAuthTag(packet.subarray(-20, -4));
  const text = Buffer.concat([decipher.update(packet.subarray(30, -20)), decipher.final()]);
  assert.deepEqual(JSON.parse(text), { from: 'app', ip: '192.168.68.109' });
});
test('LAN advertisement parsing returns the real source address and protocol', () => {
  const parser = new MessageParser({ key: UDP_KEY, version: '3.3' });
  const packet = parser.encode({ data: { gwId: 'dev-1', ip: '203.0.113.5', version: '3.3' },
    commandByte: 19, sequenceN: 1, encrypted: true });
  assert.deepEqual(parseAdvertisement(packet, '192.168.68.123'), { id: 'dev-1', ip: '192.168.68.123', version: '3.3' });
  assert.equal(parseAdvertisement(Buffer.from('invalid'), '192.168.68.123'), null);
});
test('discovered address changes override old cached DHCP addresses', () => {
  const local = new LocalTransport(config, log);
  local.addresses.set(device.id, { ip: '192.168.68.111', version: '3.4' });
  assert.equal(local.address(device).ip, '192.168.68.111');
  assert.deepEqual(local.address(device, { ip: '192.168.68.222', version: '3.5' }), { ip: '192.168.68.222', version: '3.5' });
});

async function server(t, handler) {
  const sockets = new Set();
  const instance = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => handler(socket, data));
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { for (const s of sockets) s.destroy(); instance.close(); });
  const port = instance.address().port;
  class TestDevice extends TuyaDevice { constructor(options) { super({ ...options, port }); } }
  return { Device: TestDevice, sockets };
}
test('real TuyAPI transport reads encrypted DPS over a TCP socket and closes it', async t => {
  const parser = new MessageParser({ key: device.localKey, version: '3.3' });
  const tcp = await server(t, (socket, data) => {
    const request = parser.parse(data)[0];
    socket.write(parser.encode({ data: { dps: { 20: true, 22: 500 } }, commandByte: 8,
      sequenceN: request.sequenceN, encrypted: true }));
  });
  const local = new LocalTransport(config, log, () => {}, tcp.Device);
  assert.deepEqual(await local.transact(device, {}), { 20: true, 22: 500 });
  assert.equal(local.active.size, 0);
  local.shutdown();
});
test('real TuyAPI multi-DP writes reach the socket as one coherent command', async t => {
  const parser = new MessageParser({ key: device.localKey, version: '3.3' });
  const received = [];
  const tcp = await server(t, (socket, data) => {
    const request = parser.parse(data)[0]; received.push(request);
    socket.write(parser.encode({ data: { dps: request.payload.dps }, commandByte: 8,
      sequenceN: request.sequenceN, encrypted: true }));
  });
  const local = new LocalTransport(config, log, () => {}, tcp.Device);
  await local.transact(device, {}, { 20: true, 21: 'colour', 24: '007802bc033f' });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].payload.dps, { 20: true, 21: 'colour', 24: '007802bc033f' });
  local.shutdown();
});
test('unresponsive local sockets time out once without reconnecting after fallback', async t => {
  let requests = 0;
  const tcp = await server(t, () => { requests++; });
  const local = new LocalTransport({ ...config, localTimeout: 0.1 }, log, () => {}, tcp.Device);
  const start = Date.now();
  await assert.rejects(local.transact(device, {}, { 20: true }));
  assert.ok(Date.now() - start < 1000);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(requests, 1);
  assert.equal(tcp.sockets.size, 0);
  assert.equal(local.active.size, 0);
  local.shutdown();
});
test('invalid and empty LAN states fall through to cloud instead of appearing successful', async t => {
  const parser = new MessageParser({ key: device.localKey, version: '3.3' });
  const tcp = await server(t, (socket, data) => {
    const request = parser.parse(data)[0];
    socket.write(parser.encode({ data: { dps: {} }, commandByte: 8, sequenceN: request.sequenceN, encrypted: true }));
  });
  const local = new LocalTransport(config, log, () => {}, tcp.Device);
  await assert.rejects(local.transact(device, {}), /LAN_EMPTY_STATE/);
  local.shutdown();
});
test('a timed-out connection never runs a delayed write', async () => {
  let writes = 0, closed = 0;
  class DelayedDevice extends EventEmitter {
    constructor() { super(); this.client = { destroy: () => { closed++; } }; }
    async connect() { await new Promise(resolve => setTimeout(resolve, 60)); }
    isConnected() { return true; }
    async set() { writes++; return true; }
    disconnect() {}
  }
  const local = new LocalTransport({ ...config, localTimeout: 0.01 }, log, () => {}, DelayedDevice);
  await assert.rejects(local.transact(device, {}, { 20: true }), /LAN_TIMEOUT/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(writes, 0); assert.ok(closed > 0);
  local.shutdown();
});
