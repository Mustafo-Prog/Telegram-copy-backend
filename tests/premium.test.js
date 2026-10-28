require('./helpers/setup');
process.env.PORT = '8800';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { accountDetails } = require('../utils/accountStatus');
const { DAY_MS, grantPremium, migrateLegacyPremium, expirePremium } = require('../services/premiumSubscriptions');
const { toMessageDto } = require('../modules/messages/message.presenter');
const { signToken } = require('../utils/token');
const BASE = 'http://localhost:8800/api';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner, ownerToken; let nextId = 0;
const sockets = [];
const create = (fields = {}) => User.create({ email: `premium-${nextId++}@premium.test`, displayName: 'Premium fixture', ...fields });
async function call(method, path, token, body) {
  const response = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const promote = (user, body) => call('POST', `/users/${user._id}/promote`, ownerToken, body);
const connect = (token) => new Promise((resolve, reject) => {
  const socket = io('http://localhost:8800', { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket); socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
});
before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await pause(30); }
  owner = await create({ status: 'superadmin', premiumExpiresAt: new Date(0) }); ownerToken = signToken(owner);
});
after(() => sockets.forEach((socket) => socket.close()));

test('new Premium grants have a server-calculated finite duration and ignore a forged unlimited expiry', async () => {
  for (const durationDays of [7, 30, 90, 365]) {
    const target = await create(); const before = Date.now();
    const result = await promote(target, { durationDays, premiumExpiresAt: null, status: 'superadmin' });
    const after = Date.now();
    assert.equal(result.status, 200); assert.equal(result.data.user.status, 'admin');
    const expiry = new Date(result.data.user.premiumExpiresAt).getTime();
    assert.ok(expiry >= before + durationDays * DAY_MS && expiry <= after + durationDays * DAY_MS);
    assert.equal(result.data.user.premiumVersion, 1);
  }
  for (const durationDays of [0, -1, 366, 1.5, null, '30']) {
    const target = await create();
    assert.equal((await promote(target, { durationDays })).status, 400);
    assert.equal((await User.findById(target._id)).status, 'user');
  }
  const invalid = await create();
  assert.equal((await promote(invalid, { durationDays: 30, renew: 'false' })).status, 400);
});

test('repeating an initial grant never extends Premium; an explicit renewal adds days to the remaining term', async () => {
  const target = await create(); const initial = (await promote(target, { durationDays: 7 })).data.user;
  const repeated = (await promote(target, { durationDays: 90 })).data.user;
  assert.equal(repeated.premiumExpiresAt, initial.premiumExpiresAt);
  const renewed = await promote(target, { durationDays: 30, renew: true, expectedExpiresAt: initial.premiumExpiresAt, expectedVersion: initial.premiumVersion });
  assert.equal(renewed.status, 200);
  assert.equal(new Date(renewed.data.user.premiumExpiresAt).getTime(), new Date(initial.premiumExpiresAt).getTime() + 30 * DAY_MS);
  const stale = await promote(target, { durationDays: 30, renew: true, expectedExpiresAt: initial.premiumExpiresAt, expectedVersion: initial.premiumVersion });
  assert.equal(stale.status, 409);
  assert.equal((await User.findById(target._id)).premiumExpiresAt.toISOString(), renewed.data.user.premiumExpiresAt);
});

test('simultaneous renewal clicks cannot double-extend the same subscription version', async () => {
  const target = await create(); const initial = (await promote(target, { durationDays: 30 })).data.user;
  const request = { durationDays: 7, renew: true, expectedExpiresAt: initial.premiumExpiresAt, expectedVersion: initial.premiumVersion };
  const results = await Promise.all([promote(target, request), promote(target, request)]);
  assert.deepEqual(results.map((entry) => entry.status).sort(), [200, 409]);
  assert.equal((await User.findById(target._id)).premiumExpiresAt.getTime(), new Date(initial.premiumExpiresAt).getTime() + 7 * DAY_MS);
});

test('expired Premium becomes user in API and message DTOs immediately, before maintenance runs', async () => {
  const target = await create({ status: 'admin', premiumExpiresAt: new Date(Date.now() - 1000) });
  const token = signToken(target);
  assert.equal((await call('GET', '/auth/me', token)).data.user.status, 'user');
  const message = (await call('POST', '/messages', token, { text: 'Expired author' })).data.message;
  assert.equal(message.senderStatus, 'user');
  assert.equal(message.senderPremiumExpiresAt, target.premiumExpiresAt.toISOString());
  assert.equal((await call('GET', `/users/by-id/${target._id}`, ownerToken)).data.user.status, 'user');
  const renewed = (await promote(target, { durationDays: 7 })).data.user;
  assert.equal(renewed.status, 'admin'); assert.ok(new Date(renewed.premiumExpiresAt).getTime() > Date.now());
});

test('maintenance expires Premium and broadcasts the change without disconnecting the user', { timeout: 5000 }, async () => {
  const now = Date.now(); const target = await create({ status: 'admin', premiumExpiresAt: new Date(now + 5000) });
  const socket = await connect(signToken(target));
  const event = new Promise((resolve) => socket.once('account:updated', resolve));
  await expirePremium(now + 5000);
  const payload = await event;
  assert.equal(payload.userId, String(target._id)); assert.equal(payload.status, 'user'); assert.equal(payload.premiumVersion, 1);
  assert.equal(socket.connected, true); assert.equal((await User.findById(target._id)).status, 'user');
});

test('renewal wins over an expiration worker scanning the old deadline', async () => {
  const now = Date.now(); const target = await create({ status: 'admin', premiumExpiresAt: new Date(now + 10000) });
  const renewed = await grantPremium(target._id, { durationDays: 7, renew: true, expectedExpiresAt: target.premiumExpiresAt.toISOString(), expectedVersion: 0 }, now);
  await expirePremium(now + 10000);
  const stored = await User.findById(target._id);
  assert.equal(stored.status, 'admin'); assert.equal(stored.premiumExpiresAt.getTime(), renewed.premiumExpiresAt.getTime());
});

test('legacy Premium receives exactly 30 days once; restarts do not extend it and superadmin never expires', async () => {
  const now = Date.now(); const legacy = await create({ status: 'admin' });
  await migrateLegacyPremium(now);
  const expected = now + 30 * DAY_MS;
  assert.equal((await User.findById(legacy._id)).premiumExpiresAt.getTime(), expected);
  await migrateLegacyPremium(now + DAY_MS);
  assert.equal((await User.findById(legacy._id)).premiumExpiresAt.getTime(), expected);
  await expirePremium(expected + DAY_MS);
  assert.equal((await User.findById(legacy._id)).status, 'user');
  const permanent = await User.findById(owner._id);
  assert.equal(accountDetails(permanent, expected + 1000 * DAY_MS).status, 'superadmin');
  assert.equal(permanent.status, 'superadmin'); assert.equal(permanent.toPublic().premiumExpiresAt, null);
  assert.equal((await promote(permanent, { durationDays: 7 })).status, 403);
});

test('expiry boundaries and missing dates never create unlimited Premium; schema never TTL-deletes users', () => {
  const now = Date.now();
  for (const premiumExpiresAt of [null, undefined, 'invalid', new Date(now - 1), new Date(now)]) assert.equal(accountDetails({ status: 'admin', premiumExpiresAt }, now).status, 'user');
  assert.equal(accountDetails({ status: 'admin', premiumExpiresAt: new Date(now + 1) }, now).status, 'admin');
  assert.ok(User.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
  const dto = toMessageDto({ _id: 'message', sentAt: new Date(now), sender: { _id: 'user', status: 'admin', premiumExpiresAt: new Date(now - 1) } });
  assert.equal(dto.senderStatus, 'user');
});
