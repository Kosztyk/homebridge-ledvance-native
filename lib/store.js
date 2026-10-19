'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class PrivateStore {
  constructor(storagePath, config, log) {
    this.log = log;
    const identity = [config.region, config.email?.toLowerCase(), config.name];
    const name = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20);
    this.file = path.join(storagePath, `ledvance-native-${name}.json`);
    this.fingerprint = crypto.createHash('sha256').update(JSON.stringify([...identity, config.password])).digest('hex');
    this.data = { fingerprint: this.fingerprint, tokens: {}, devices: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.fingerprint === this.fingerprint) this.data = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn('Could not read the LEDVANCE cache; it will be rebuilt.');
    }
  }
  update(patch) {
    Object.assign(this.data, patch);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
      this.timer.unref?.();
    }
  }
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch { this.log.warn('Could not save the LEDVANCE cache. Check Homebridge storage permissions.'); }
  }
  close() { clearTimeout(this.timer); this.timer = null; this.flush(); }
}

module.exports = { PrivateStore };
