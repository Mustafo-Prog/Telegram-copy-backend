require('./helpers/setup');
process.env.PORT = '8700';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { LoginCode } = require('../models/LoginCode');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');
const { accountStatus } = require('../utils/accountStatus');
const otp = require('../utils/otp');
const { memdb } = require('./helpers/setup');
const BASE = 'http://localhost:8700/api';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let regular, premium, owner, secondOwner, u, p, s, otherS;
const sockets = [];

async function call(method, path, token, body) {
  const response = await fetch(BASE + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const send = async (token = u) => (await call('POST', '/messages', token, { text: 'Status permission fixture' })).data.message;
const promote = (id, token = s, body) => call('POST', `/users/${id}/promote`, token, body);
const connect = (token) => new Promise((resolve, reject) => {
  const socket = io('http://localhost:8700', { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket); socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
});

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await pause(30); }
  [regular, premium, owner, secondOwner] = await Promise.all([
    ['ordinary', 'user'], ['premium', 'admin'], ['owner', 'superadmin'], ['second_owner', 'superadmin'],
  ].map(([name, status]) => User.create({ email: `${name}@status.test`, displayName: name, username: name, status,
    ...(status === 'admin' ? { premiumExpiresAt: new Date(Date.now() + 30 * 86400000) } : {}) })));
  [u, p, s, otherS] = [regular, premium, owner, secondOwner].map(signToken);
});
after(() => sockets.forEach((socket) => socket.close()));

test('new and legacy accounts default to user; invalid statuses never grant permissions', async () => {
  const model = new User({ email: 'default@status.test', displayName: 'Default' });
  assert.equal(model.status, 'user');
  await assert.rejects(new User({ email: 'bad@status.test', displayName: 'Bad', status: 'owner' }).validate());
  const legacy = await User.create({ email: 'legacy@status.test', displayName: 'Legacy' });
  delete memdb.storeOf(User).get(String(legacy._id)).status;
  const response = await call('GET', '/auth/me', signToken(legacy));
  assert.equal(response.data.user.status, 'user');
  for (const value of [null, undefined, '', 'ADMIN', 'owner']) assert.equal(accountStatus(value), 'user');
});

test('login and ordinary profile editing cannot set or upgrade account status', async () => {
  const email = 'new-account@status.test';
  await LoginCode.create({ email, codeHash: otp.hashCode(email, '123456'), attempts: 0,
    codeExpiresAt: new Date(Date.now() + 600000), expiresAt: new Date(Date.now() + 3600000) });
  const login = await call('POST', '/auth/verify-code', null, { email, code: '123456', status: 'superadmin' });
  assert.equal(login.status, 200); assert.equal(login.data.user.status, 'user');
  const patched = await call('PATCH', '/users/me', login.data.token, { displayName: 'Edited', status: 'superadmin', role: 'superadmin' });
  assert.equal(patched.status, 200); assert.equal(patched.data.user.status, 'user');
  assert.equal((await call('PATCH', '/users/me', u, { status: 'admin' })).status, 400);
});

test('Premium has no general-chat moderation and cannot use Promote, even with forged body flags', async () => {
  const message = await send();
  for (const token of [p, u]) {
    if (token === p) assert.equal((await call('DELETE', `/messages/${message.id}`, token, { canDeleteGeneralOthers: true, status: 'superadmin' })).status, 403);
    const bulk = await call('POST', '/messages/bulk-delete', token, { ids: [message.id], mode: 'everyone', canDeleteGeneralOthers: true });
    assert.equal(bulk.data.deleted, token === u ? 1 : 0);
    assert.equal((await promote(String(regular._id), token)).status, 403);
  }
  const foreign = await send();
  assert.equal((await call('DELETE', `/messages/${foreign.id}`, p)).status, 403);
  assert.equal((await promote(String(regular._id), null)).status, 401);
});

test('superadmin can delete other authors’ general messages singly and in bulk, with realtime removal', { timeout: 5000 }, async () => {
  const socket = await connect(u);
  const message = await send(p);
  const event = new Promise((resolve) => socket.once('message:deleted', resolve));
  assert.equal((await call('DELETE', `/messages/${message.id}`, s)).data.deleted, 1);
  assert.deepEqual((await event).ids, [message.id]);
  const messages = await Promise.all([send(u), send(p)]);
  const result = await call('POST', '/messages/bulk-delete', s, { ids: messages.map((entry) => entry.id), mode: 'everyone' });
  assert.equal(result.data.deleted, 2);
  assert.equal(await Message.countDocuments({ _id: { $in: messages.map((entry) => entry.id) } }), 0);
  const editable = await send(u);
  assert.equal((await call('PATCH', `/messages/${editable.id}`, s, { text: 'forged edit' })).status, 403);
});

test('Premium and superadmin statuses do not grant access to private conversations or group administration', async () => {
  const chat = (await call('POST', '/conversations', u, { userId: String(premium._id) })).data.conversation;
  assert.equal((await call('GET', `/conversations/${chat.id}/messages`, s)).status, 404);
  const group = (await call('POST', '/groups', u, { title: 'Independent group roles', memberIds: [String(premium._id), String(owner._id)] })).data.conversation;
  for (const token of [p, s]) assert.equal((await call('PATCH', `/groups/${group.id}`, token, { title: 'Forbidden rename' })).status, 403);
});

test('Promote only assigns admin and is idempotent; self and other superadmins remain protected', async () => {
  const target = await User.create({ email: 'promote-target@status.test', displayName: 'Target' });
  const results = await Promise.all([promote(String(target._id), s, { status: 'superadmin' }), promote(String(target._id), otherS)]);
  assert.ok(results.every((response) => response.status === 200 && response.data.user.status === 'admin'));
  assert.equal((await User.findById(target._id)).status, 'admin');
  assert.equal((await promote(String(target._id))).data.user.status, 'admin');
  assert.equal((await promote(String(owner._id))).status, 403);
  assert.equal((await promote(String(secondOwner._id))).status, 403);
  assert.equal((await promote('not-an-id')).status, 404);
  assert.equal((await promote('000000000000000000000001')).status, 404);
});

test('promotions notify the target and update public profiles without exposing email', { timeout: 5000 }, async () => {
  const target = await User.create({ email: 'live-target@status.test', displayName: 'Live target' });
  const [targetSocket, observer] = await Promise.all([connect(signToken(target)), connect(u)]);
  const ownEvent = new Promise((resolve) => targetSocket.once('account:updated', resolve));
  const publicEvent = new Promise((resolve) => observer.once('user:updated', resolve));
  const response = await promote(String(target._id));
  assert.equal(response.status, 200);
  const expected = { userId: String(target._id), status: 'admin', premiumExpiresAt: response.data.user.premiumExpiresAt, premiumVersion: 1 };
  assert.deepEqual(await ownEvent, expected);
  assert.deepEqual(await publicEvent, expected);
  const profile = (await call('GET', `/users/by-id/${target._id}`, u)).data.user;
  assert.equal(profile.status, 'admin'); assert.equal(profile.username, null); assert.equal(Object.hasOwn(profile, 'email'), false);
  assert.equal((await call('GET', `/users/by-id/${target._id}`, null)).status, 401);
  assert.equal((await call('GET', '/users/by-id/invalid', u)).status, 404);
  assert.equal((await call('GET', '/auth/me', signToken(target))).data.user.status, 'admin');
});

test('manual database status changes take effect on the next authenticated request with the same token', async () => {
  const target = await User.create({ email: 'manual-change@status.test', displayName: 'Manual change' });
  const token = signToken(target); const message = await send();
  assert.equal((await call('DELETE', `/messages/${message.id}`, token)).status, 403);
  await User.updateOne({ _id: target._id }, { status: 'superadmin' });
  assert.equal((await call('DELETE', `/messages/${message.id}`, token)).data.deleted, 1);
  await User.updateOne({ _id: target._id }, { status: 'admin' });
  assert.equal((await call('DELETE', `/messages/${(await send()).id}`, token)).status, 403);
});
