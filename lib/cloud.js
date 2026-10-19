'use strict';

// The OEM identity, signing algorithm and login flow are ported from the
// supplied hass-ledvance integration. See NOTICE for upstream attribution.
const crypto = require('node:crypto');

const REGIONS = Object.freeze({
  EU: { endpoint: 'https://a1.tuyaeu.com/api.json', countryCode: 49 },
  US: { endpoint: 'https://a1.tuyaus.com/api.json', countryCode: 1 },
  'US (Sylvania app)': { endpoint: 'https://a1.tuyaus.com/api.json', countryCode: 1, sylvania: true },
  China: { endpoint: 'https://a1.tuyacn.com/api.json', countryCode: 86 },
  India: { endpoint: 'https://a1.tuyain.com/api.json', countryCode: 91 },
});
const APP = {
  ledvance: { id: 'fx3fvkvusmw45d7jn8xh', key: 'A_armptsqyfpxa4ftvtc739ardncett3uy_cgqx3ku34mh5qdesd7fcaru3gx7tyurr' },
  sylvania: { id: 'creq75hn4vdg5qvrgryp', key: 'A_ag4xcmp9rjttkj9yf9e8c3wfxry7yr44_wparh3scdv8dc7rrnuegaf9mqmn4snpk' },
};
const SIGNED = new Set(['a', 'v', 'lat', 'lon', 'lang', 'deviceId', 'imei', 'imsi', 'appVersion',
  'ttid', 'isH5', 'h5Token', 'os', 'clientId', 'postData', 'time', 'requestId', 'n4h5', 'sid', 'sp', 'et']);

class CloudError extends Error {
  constructor(code, message) {
    super(message || `LEDVANCE cloud error (${String(code).replace(/[^A-Z0-9_]/gi, '').slice(0, 100)})`);
    this.name = 'CloudError';
    this.code = code;
  }
}
function mobileHash(value) {
  const h = crypto.createHash('md5').update(value).digest('hex');
  return h.slice(8, 16) + h.slice(0, 8) + h.slice(24, 32) + h.slice(16, 24);
}
function sign(data, secret) {
  const message = Object.keys(data).sort().filter(k => SIGNED.has(k) && data[k] !== undefined && String(data[k]))
    .map(k => `${k}=${k === 'postData' ? mobileHash(data[k]) : data[k]}`).join('||');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}
function encryptPassword(publicKey, exponent, password) {
  const n = BigInt(publicKey), e = BigInt(exponent);
  if (n <= 1n || e <= 0n) throw new CloudError('INVALID_RSA_KEY');
  const digest = crypto.createHash('md5').update(password).digest('hex');
  let base = BigInt(`0x${Buffer.from(digest, 'utf8').toString('hex')}`) % n;
  let power = e, encrypted = 1n;
  while (power > 0n) {
    if (power & 1n) encrypted = encrypted * base % n;
    base = base * base % n;
    power >>= 1n;
  }
  let hex = encrypted.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return '0'.repeat(64) + hex;
}
function parseJSON(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalizeDevice(raw) {
  if (!raw || !raw.devId) throw new CloudError('INVALID_DEVICE');
  const schema = parseJSON(raw.schema, []), dps = parseJSON(raw.dps, {});
  return {
    id: String(raw.devId), gatewayId: String(raw.gwId || raw.devId), name: String(raw.name || raw.devId),
    productId: String(raw.productId || ''), online: raw.isOnline === true || raw.isOnline === 1,
    localKey: String(raw.localKey || ''), firmware: String(raw.bv || raw.firmwareVersion || '1.0.0'),
    mac: String(raw.mac || ''), schema: Array.isArray(schema) ? schema : [],
    dps: dps && typeof dps === 'object' && !Array.isArray(dps) ? dps : {},
    // Cloud 'pv' is not reliably the LAN protocol version; discovery determines it.
  };
}

class LedvanceCloud {
  constructor(config, { fetchImpl = globalThis.fetch, tokens = {}, onTokens = () => {} } = {}) {
    this.config = config;
    this.region = REGIONS[config.region || 'EU'];
    if (!this.region) throw new CloudError('INVALID_REGION', 'Select a valid LEDVANCE region.');
    this.app = APP[this.region.sylvania ? 'sylvania' : 'ledvance'];
    this.fetch = fetchImpl;
    this.sid = tokens.sid || '';
    this.refreshToken = tokens.refreshToken || '';
    this.onTokens = onTokens;
    this.loginPromise = null;
    this.rateLimitedUntil = 0;
    this.controllers = new Set();
    this.stopped = false;
    this.authenticationFailed = false;
  }

  async request(action, data, { auth = true, retry = true, gid, version = '1.0' } = {}) {
    if (this.stopped) throw new CloudError('SHUTDOWN');
    if (auth && this.authenticationFailed) throw new CloudError('AUTHENTICATION_FAILED', 'Correct your LEDVANCE credentials/region and restart Homebridge.');
    if (Date.now() < this.rateLimitedUntil) throw new CloudError('RATE_LIMITED', 'LEDVANCE cloud rate limit; backing off before retrying.');
    if (auth && !this.sid) await this.login();
    const postData = data === undefined ? undefined : JSON.stringify(data);
    const params = {
      appVersion: '1.1.6', appRnVersion: '5.14', channel: 'oem',
      deviceId: '5fe5abb36728cce7b9cd2185625edccbd6d9bd787e40', platform: 'Linux',
      requestId: crypto.randomUUID(), lang: 'en', clientId: this.app.id, osSystem: '9', os: 'Android',
      timeZoneId: 'America/Sao_Paulo', ttid: `sdk_tuya@${this.app.id}`, et: '0.0.1',
      v: version, sdkVersion: '3.10.0', time: String(Math.floor(Date.now() / 1000)), a: action,
    };
    if (gid !== undefined) params.gid = String(gid);
    if (auth) params.sid = this.sid;
    params.sign = sign({ ...params, ...(postData === undefined ? {} : { postData }) }, this.app.key);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), (this.config.requestTimeout || 8) * 1000);
    timeout.unref?.();
    let body;
    try {
      const response = await this.fetch(`${this.region.endpoint}?${new URLSearchParams(params)}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'User-Agent': 'TY-UA=APP/Android/1.1.6/SDK/null', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: postData === undefined ? undefined : new URLSearchParams({ postData }).toString(),
      });
      if (response.status === 429) {
        this.rateLimitedUntil = Date.now() + 60000;
        throw new CloudError('RATE_LIMITED', 'LEDVANCE cloud rate limit; backing off for 60 seconds.');
      }
      if (!response.ok) throw new CloudError('HTTP_ERROR', `LEDVANCE cloud returned HTTP ${response.status}.`);
      body = await response.json();
    } catch (error) {
      if (error instanceof CloudError) throw error;
      // Never forward fetch exceptions: signed URLs contain session credentials.
      throw new CloudError('NETWORK_ERROR', controller.signal.aborted ? 'LEDVANCE cloud request timed out.' : 'Cannot reach the LEDVANCE cloud.');
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
    if (body?.success === true) return body.result;
    const code = body?.errorCode || 'UNKNOWN_ERROR';
    if (code === 'USER_SESSION_INVALID' && auth && retry) {
      // Another in-flight request may already have renewed the old session.
      if (this.sid === params.sid) {
        this.sid = '';
        await this.login();
      } else if (!this.sid) await this.login();
      return this.request(action, data, { auth, retry: false, gid, version });
    }
    if (code === 'REQUEST_TOO_FREQUENTLY_PLEASE_TRY_AGAIN_LATER') {
      this.rateLimitedUntil = Date.now() + 60000;
      throw new CloudError('RATE_LIMITED', 'LEDVANCE cloud rate limit; backing off for 60 seconds.');
    }
    if (['USER_PASSWD_WRONG', 'USER_NOT_EXIST', 'USER_EMAIL_NOT_EXIST'].includes(code)) {
      this.authenticationFailed = true;
      throw new CloudError('AUTHENTICATION_FAILED', 'LEDVANCE rejected the login. Check your app account, password and region.');
    }
    throw new CloudError(code);
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.performLogin();
    try { await this.loginPromise; } finally { this.loginPromise = null; }
  }

  async performLogin() {
    if (this.refreshToken) {
      try {
        const tokens = await this.request('tuya.m.user.session.update', { refreshToken: this.refreshToken }, { auth: false });
        if (!tokens?.sid) throw new CloudError('INVALID_SESSION_RESPONSE');
        this.saveTokens(tokens);
        return;
      } catch (error) {
        if (['RATE_LIMITED', 'NETWORK_ERROR', 'HTTP_ERROR', 'SHUTDOWN'].includes(error.code)) throw error;
        this.refreshToken = '';
      }
    }
    const countryCode = this.config.countryCode || this.region.countryCode;
    const token = await this.request('tuya.m.user.email.token.create', { countryCode, email: this.config.email }, { auth: false });
    if (!token?.publicKey || !token?.exponent || !token?.token) throw new CloudError('INVALID_LOGIN_RESPONSE');
    const tokens = await this.request('tuya.m.user.email.password.login', {
      countryCode: String(countryCode), email: this.config.email, ifencrypt: 1, options: '{"group": 1}',
      passwd: encryptPassword(token.publicKey, token.exponent, this.config.password), token: token.token,
    }, { auth: false });
    if (!tokens?.sid) throw new CloudError('INVALID_SESSION_RESPONSE');
    this.saveTokens(tokens);
  }

  saveTokens(tokens) {
    this.sid = tokens.sid;
    this.refreshToken = tokens.refreshToken || this.refreshToken || '';
    this.onTokens({ sid: this.sid, refreshToken: this.refreshToken });
  }

  async discover(onDeviceError = () => {}) {
    const groups = await this.request('tuya.m.location.list');
    if (!Array.isArray(groups)) throw new CloudError('INVALID_HOME_LIST');
    const devices = new Map();
    const present = new Set();
    for (const group of groups) {
      const gid = group.groupId || group.locationId;
      if (gid === undefined || gid === null || gid === '') continue;
      let list;
      try { list = await this.request('tuya.m.my.group.device.list', undefined, { gid }); }
      catch (error) {
        if (['AUTHENTICATION_FAILED', 'RATE_LIMITED'].includes(error.code)) throw error;
        onDeviceError('home', error); continue;
      }
      if (!Array.isArray(list)) { onDeviceError('home', new CloudError('INVALID_DEVICE_LIST')); continue; }
      for (const item of list) {
        if (!item?.devId) continue;
        const id = String(item.devId);
        present.add(id);
        if (devices.has(id)) continue;
        try { devices.set(id, normalizeDevice(await this.request('tuya.m.device.get', { devId: id }))); }
        catch (error) {
          if (['AUTHENTICATION_FAILED', 'RATE_LIMITED'].includes(error.code)) throw error;
          onDeviceError(id, error);
        }
      }
    }
    return { devices: [...devices.values()], present };
  }

  async getDps(id) {
    const dps = parseJSON(await this.request('tuya.m.device.dp.get', { devId: id }), null);
    if (!dps || Array.isArray(dps) || typeof dps !== 'object' || Object.keys(dps).length === 0) throw new CloudError('EMPTY_STATE');
    return dps;
  }
  async setDps(device, dps) {
    const result = await this.request('tuya.m.device.dp.publish', {
      devId: device.id, gwId: device.gatewayId || device.id, dps: JSON.stringify(dps),
    });
    if (result === false) throw new CloudError('COMMAND_REJECTED', 'The LEDVANCE cloud rejected the command.');
    return true;
  }
  shutdown() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }
}

module.exports = { LedvanceCloud, CloudError, REGIONS, mobileHash, sign, encryptPassword, normalizeDevice };
