'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LedvanceCloud, sign, mobileHash, encryptPassword } = require('../lib/cloud');
const vector = require('./fixtures/protocol.json');
const config = { email: 'test@example.com', password: 'unit-test', region: 'EU', requestTimeout: 1 };
const ok = result => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
const fail = (errorCode, errorMsg) => ({ ok: true, status: 200, json: async () => ({ success: false, errorCode, errorMsg }) });
function client(responder, tokens = { sid: 'test-session' }, override = {}) {
  const calls = [];
  const api = new LedvanceCloud({ ...config, ...override }, { tokens, fetchImpl: async (url, init) => {
    const params = Object.fromEntries(new URL(url).searchParams);
    const postData = new URLSearchParams(init.body).get('postData');
    const data = postData ? JSON.parse(postData) : undefined;
    calls.push({ params, data, url, init });
    return responder(params.a, data, params, calls);
  } });
  return { api, calls };
}

test('signing and textbook RSA match independent Python vectors', () => {
  assert.equal(mobileHash(vector.data.postData), vector.hash);
  assert.equal(sign({ ...vector.data, unrecognized: 'ignored', sign: 'old' }, vector.secret), vector.sign);
  assert.equal(encryptPassword(vector.rsa.n, vector.rsa.e, vector.rsa.password), vector.rsa.encrypted);
});
test('cloud DPS writes use the correct OEM endpoint, action, JSON string and API version', async () => {
  const { api, calls } = client(() => ok(true));
  await api.setDps({ id: 'bulb', gatewayId: 'gateway' }, { 20: true, 22: 500 });
  assert.equal(new URL(calls[0].url).hostname, 'a1.tuyaeu.com');
  assert.equal(calls[0].params.a, 'tuya.m.device.dp.publish');
  assert.equal(calls[0].params.v, '1.0');
  assert.deepEqual(calls[0].data, { devId: 'bulb', gwId: 'gateway', dps: '{"20":true,"22":500}' });
  const { postData } = Object.fromEntries(new URLSearchParams(calls[0].init.body));
  assert.equal(calls[0].params.sign, sign({ ...calls[0].params, postData }, vector.secret));
});
test('discovery visits all homes, retains numeric IDs and avoids unsupported optional room API', async () => {
  const { api, calls } = client((action, data, params) => {
    if (action === 'tuya.m.location.list') return ok([{ groupId: 1 }, { locationId: '2' }]);
    if (action === 'tuya.m.my.group.device.list') return ok([{ devId: 'dev' + params.gid }]);
    return ok({ devId: data.devId, name: 'Strip', gwId: 'gw', isOnline: true,
      localKey: '0123456789abcdef', schema: '[{"id":20,"code":"switch_led"}]', dps: { 20: false }, pv: '9.0', localIp: '203.0.113.1' });
  });
  const result = await api.discover();
  assert.equal(result.devices.length, 2);
  assert.deepEqual([...result.present], ['dev1', 'dev2']);
  assert.equal(result.devices[0].schema[0].id, 20);
  assert.equal(result.devices[0].lanIp, undefined);
  assert.equal(result.devices[0].lanVersion, undefined);
  assert.ok(!calls.some(c => c.params.a.includes('room')));
  assert.ok(calls.every(c => c.params.v === '1.0'));
});
test('a failed device does not prevent discovering the rest of its home', async () => {
  const failures = [];
  const { api } = client((action, data) => action === 'tuya.m.location.list' ? ok([{ groupId: 1 }]) :
    action === 'tuya.m.my.group.device.list' ? ok([{ devId: 'bad' }, { devId: 'good' }]) :
      data.devId === 'bad' ? fail('DEVICE_NOT_EXIST') : ok({ devId: 'good', schema: [] }));
  const result = await api.discover((id, error) => failures.push([id, error.code]));
  assert.equal(result.devices[0].id, 'good');
  assert.deepEqual(failures, [['bad', 'DEVICE_NOT_EXIST']]);
  assert.equal(result.present.size, 2);
});
test('expired sessions silently refresh and retry the original request once', async () => {
  const saved = [];
  const { api, calls } = client((action, data, params) => action === 'tuya.m.user.session.update' ?
    ok({ sid: 'new-session', refreshToken: 'new-refresh' }) : params.sid === 'old-session' ? fail('USER_SESSION_INVALID') : ok({ 20: true }),
  { sid: 'old-session', refreshToken: 'refresh' });
  api.onTokens = t => saved.push(t);
  assert.deepEqual(await api.getDps('bulb'), { 20: true });
  assert.deepEqual(calls.map(c => c.params.a), ['tuya.m.device.dp.get', 'tuya.m.user.session.update', 'tuya.m.device.dp.get']);
  assert.equal(calls[1].params.sid, undefined);
  assert.equal(saved[0].sid, 'new-session');
});
test('concurrent initial requests share one password login', async () => {
  const { api, calls } = client(action => action === 'tuya.m.user.email.token.create' ?
    ok({ token: 'temporary', publicKey: vector.rsa.n, exponent: vector.rsa.e }) :
    action === 'tuya.m.user.email.password.login' ? ok({ sid: 'new' }) : ok({ 20: true }), {});
  await Promise.all([api.getDps('a'), api.getDps('b')]);
  assert.equal(calls.filter(c => c.params.a === 'tuya.m.user.email.password.login').length, 1);
  assert.ok(calls.filter(c => c.params.a === 'tuya.m.device.dp.get').every(c => c.params.sid === 'new'));
});
test('rejected refresh tokens fall back to password login, network failures do not', async () => {
  const { api, calls } = client(action => action === 'tuya.m.user.session.update' ? fail('USER_SESSION_INVALID') :
    action === 'tuya.m.user.email.token.create' ? ok({ token: 't', publicKey: vector.rsa.n, exponent: vector.rsa.e }) : ok({ sid: 'new' }),
  { refreshToken: 'expired' });
  await api.login();
  assert.equal(calls.length, 3);
  const broken = client(() => { throw new Error('https://unsafe?sid=SECRET'); }, { refreshToken: 'valid' });
  await assert.rejects(broken.api.login(), { code: 'NETWORK_ERROR' });
  assert.equal(broken.calls.length, 1);
  assert.equal(broken.api.refreshToken, 'valid');
});
test('rate limits stop subsequent requests for the cooldown period', async () => {
  const { api, calls } = client(() => fail('REQUEST_TOO_FREQUENTLY_PLEASE_TRY_AGAIN_LATER'));
  await assert.rejects(api.getDps('a'), { code: 'RATE_LIMITED' });
  await assert.rejects(api.getDps('b'), { code: 'RATE_LIMITED' });
  assert.equal(calls.length, 1);
});
test('provider messages and fetch URLs containing credentials never escape as errors', async () => {
  const { api } = client(() => fail('USER_PASSWD_WRONG', 'password=SECRET sid=SECRET'));
  await assert.rejects(api.getDps('a'), error => !error.message.includes('SECRET') && error.code === 'AUTHENTICATION_FAILED');
  const broken = client(() => { throw new Error('https://unsafe?sid=SECRET'); });
  await assert.rejects(broken.api.getDps('a'), error => !error.message.includes('SECRET'));
});
test('a rejected password is not retried by background polling until restart', async () => {
  const { api, calls } = client(() => fail('USER_PASSWD_WRONG'));
  await assert.rejects(api.getDps('a'), { code: 'AUTHENTICATION_FAILED' });
  await assert.rejects(api.getDps('b'), { code: 'AUTHENTICATION_FAILED' });
  assert.equal(calls.length, 1);
});
test('Sylvania app uses its own OEM identity and US endpoint', async () => {
  const { api, calls } = client(() => ok({ 1: true }), undefined, { region: 'US (Sylvania app)' });
  await api.getDps('plug');
  assert.equal(calls[0].params.clientId, 'creq75hn4vdg5qvrgryp');
  assert.equal(new URL(calls[0].url).hostname, 'a1.tuyaus.com');
});
test('false command result and empty DPS responses are errors', async () => {
  const { api } = client(() => ok(false));
  await assert.rejects(api.setDps({ id: 'x' }, { 1: true }), { code: 'COMMAND_REJECTED' });
  const empty = client(() => ok({}));
  await assert.rejects(empty.api.getDps('x'), { code: 'EMPTY_STATE' });
});
test('cloud shutdown aborts pending HTTP requests', async () => {
  const api = new LedvanceCloud(config, { tokens: { sid: 's' }, fetchImpl: (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const pending = api.getDps('x'); api.shutdown();
  await assert.rejects(pending, { code: 'NETWORK_ERROR' });
  await assert.rejects(api.getDps('x'), { code: 'SHUTDOWN' });
});
