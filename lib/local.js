'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const TuyaDevice = require('tuyapi');
// Pinned TuyAPI 7.7.1 supplies the framing/cryptography for all LAN versions.
const { MessageParser } = require('tuyapi/lib/message-parser');
const { UDP_KEY } = require('tuyapi/lib/config');

const VERSIONS = new Set(['3.1', '3.2', '3.3', '3.4', '3.5']);
function broadcast(address, mask) {
  const a = address.split('.').map(Number), m = mask.split('.').map(Number);
  return a.map((n, i) => (n | (~m[i] & 255))).join('.');
}
function discoveryPacket(address) {
  // Tuya REQ_DEVINFO (0x25), GCM UDP discovery, as used by tinytuya.
  const payload = Buffer.from(JSON.stringify({ from: 'app', ip: address }));
  const header = Buffer.alloc(18);
  header.writeUInt32BE(0x6699, 0);
  header.writeUInt32BE(0x25, 10);
  header.writeUInt32BE(payload.length + 28, 14);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', UDP_KEY, nonce);
  cipher.setAAD(header.subarray(4));
  return Buffer.concat([header, nonce, cipher.update(payload), cipher.final(), cipher.getAuthTag(), Buffer.from('00009966', 'hex')]);
}
function parseAdvertisement(message, address) {
  try {
    const version = message.readUInt32BE(0) === 0x6699 ? '3.5' : '3.3';
    const packet = new MessageParser({ key: UDP_KEY, version }).parse(message)[0]?.payload;
    const id = packet?.gwId || packet?.devId;
    const pv = String(packet?.version || '');
    if (!id || net.isIPv4(address) === false || !VERSIONS.has(pv)) return null;
    return { id: String(id), ip: address, version: pv };
  } catch { return null; }
}

class LocalTransport {
  constructor(config, log, onAddress = () => {}, Device = TuyaDevice) {
    this.config = config; this.log = log; this.onAddress = onAddress; this.Device = Device;
    this.addresses = new Map(); this.sockets = new Set(); this.active = new Set(); this.stopped = false;
  }
  start() {
    if (!this.config.localControl) return;
    for (const port of [6666, 6667, 7000]) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sockets.add(socket);
      socket.on('error', () => {
        this.log.warn(`LEDVANCE LAN discovery cannot listen on UDP ${port}; cloud control remains available.`);
        try { socket.close(); } catch { /* already closed */ }
        this.sockets.delete(socket);
      });
      socket.on('message', (message, remote) => {
        const found = parseAdvertisement(message, remote.address);
        if (!found) return;
        const old = this.addresses.get(found.id);
        this.addresses.set(found.id, found);
        if (old?.ip !== found.ip || old?.version !== found.version) this.onAddress(found);
      });
      socket.bind(port, () => { socket.unref(); });
    }
    this.probe();
    this.timer = setInterval(() => this.probe(), this.config.lanDiscoveryInterval * 1000);
    this.timer.unref();
  }
  probe() {
    if (this.stopped || !this.config.localControl) return;
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const iface of interfaces || []) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        const socket = dgram.createSocket('udp4');
        this.sockets.add(socket);
        const close = () => { this.sockets.delete(socket); try { socket.close(); } catch { /* closed */ } };
        socket.on('error', close);
        socket.on('message', (message, remote) => {
          const found = parseAdvertisement(message, remote.address);
          if (found) { this.addresses.set(found.id, found); this.onAddress(found); }
        });
        socket.bind(0, iface.address, () => {
          if (this.stopped) return close();
          socket.setBroadcast(true);
          socket.send(discoveryPacket(iface.address), 7000, broadcast(iface.address, iface.netmask), () => {});
          socket.unref();
          const timer = setTimeout(close, 5000); timer.unref();
        });
      }
    }
  }
  address(device, override = {}) {
    const discovered = this.addresses.get(device.id);
    if (override.ip) return { ip: override.ip, version: override.version || discovered?.version || '3.3' };
    return discovered || (device.lanIp && VERSIONS.has(device.lanVersion) ? { ip: device.lanIp, version: device.lanVersion } : null);
  }
  async transact(device, override, patch) {
    if (!this.config.localControl || this.stopped) throw new Error('LAN_DISABLED');
    const address = this.address(device, override);
    if (!address || !device.localKey || device.localKey.length !== 16) throw new Error('LAN_NOT_DISCOVERED');
    const client = new this.Device({ id: device.id, ip: address.ip, key: device.localKey,
      version: address.version, issueGetOnConnect: false, issueRefreshOnConnect: false });
    this.active.add(client);
    // Disable TuyAPI's long automatic reconnect retries. A single bounded
    // attempt prevents a late LAN write after we have fallen back to cloud.
    client._connectTimeout = this.config.localTimeout;
    client._responseTimeout = this.config.localTimeout / 2.5;
    client._send = buffer => new Promise((resolve, reject) => {
      if (this.stopped || !client.isConnected()) return reject(new Error('LAN_DISCONNECTED'));
      const sequence = client._currentSequenceN;
      client._resolvers[sequence] = resolve;
      client.client.write(buffer, error => { if (error) reject(new Error('LAN_WRITE_FAILED')); });
    });
    let deadline;
    const failure = new Promise((_, reject) => {
      client.on('error', () => reject(new Error('LAN_ERROR')));
      client.on('disconnected', () => reject(new Error('LAN_DISCONNECTED')));
      deadline = setTimeout(() => reject(new Error('LAN_TIMEOUT')), this.config.localTimeout * 1000);
    });
    try {
      const operation = (async () => {
        await client.connect();
        if (this.stopped || !this.active.has(client)) throw new Error('LAN_CANCELLED');
        const result = patch === undefined ? await client.get({ schema: true }) :
          await client.set({ multiple: true, data: patch, shouldWaitForResponse: true });
        if (result === false || result?.Error || typeof result === 'string') throw new Error('LAN_REJECTED');
        if (patch === undefined) {
          const dps = result?.dps || result?.data?.dps;
          if (!dps || typeof dps !== 'object' || Object.keys(dps).length === 0) throw new Error('LAN_EMPTY_STATE');
          return dps;
        }
        return true;
      })();
      return await Promise.race([operation, failure]);
    } finally {
      clearTimeout(deadline);
      this.active.delete(client);
      client.disconnect();
      client.client?.destroy();
      // Keep the error listener for delayed socket callbacks during close.
    }
  }
  shutdown() {
    this.stopped = true; clearInterval(this.timer);
    for (const socket of this.sockets) { try { socket.close(); } catch { /* closed */ } }
    this.sockets.clear();
    for (const client of this.active) { client.disconnect(); client.client?.destroy(); }
    this.active.clear();
  }
}

module.exports = { LocalTransport, parseAdvertisement, discoveryPacket, broadcast };
