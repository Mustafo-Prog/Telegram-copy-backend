require('./helpers/setup');
process.env.PORT = '8300';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { GeneralReadState } = require('../models/GeneralReadState');
const { signToken } = require('../utils/token');

const BASE = 'http://localhost:8300/api';
const sockets = [];
let alice, bob, carol, a, b, c;

async function call(method, path, token, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
const send = async (token, text) => (await call('POST', '/messages', token, { text })).data.message;
const read = (token, messageId) => call('POST', '/messages/read', token, { messageId });
const messages = async (token = a) => (await call('GET', '/messages', token)).data.messages;
const find = async (id, token = a) => (await messages(token)).find((message) => message.id === id);

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  alice = await User.create({ email: 'alice-general@example.test', displayName: 'Alice' });
  bob = await User.create({ email: 'bob-general@example.test', displayName: 'Bob' });
  carol = await User.create({ email: 'carol-general@example.test', displayName: 'Carol' });
  a = signToken(alice); b = signToken(bob); c = signToken(carol);
});
after(() => sockets.forEach((socket) => socket.close()));

test('reading your own message and merely fetching the chat do not mark it read', async () => {
  const message = await send(a, 'only the author has seen this');
  assert.equal(message.readByOther, false);
  assert.equal((await read(a, message.id)).status, 200);
  await messages(b);
  assert.equal((await find(message.id)).readByOther, false);
});

test('another reader marks only messages through the viewed cursor; late receipts cannot regress it', async () => {
  const first = await send(a, 'first');
  const second = await send(a, 'second');
  assert.equal((await read(b, second.id)).status, 200);
  assert.equal((await find(first.id)).readByOther, true);
  assert.equal((await find(second.id)).readByOther, true);
  const future = await send(a, 'not viewed yet');
  assert.equal((await find(future.id)).readByOther, false);
  await read(a, future.id);
  assert.equal((await find(future.id)).readByOther, false, 'the author still cannot read their own message');
  assert.equal((await read(b, first.id)).data.messageId, second.id);
  assert.equal((await find(future.id)).readByOther, false);
});

test('the highest reader is excluded from their own messages, while other authors remain read', async () => {
  const older = await send(c, 'Carol earlier');
  const middle = await send(b, 'Bob middle');
  const latest = await send(a, 'Alice latest');
  await read(b, middle.id);
  await read(a, latest.id);
  assert.equal((await find(older.id)).readByOther, true);
  assert.equal((await find(middle.id)).readByOther, true);
  assert.equal((await find(latest.id)).readByOther, false);
  await read(c, latest.id);
  assert.equal((await find(latest.id)).readByOther, true);
});

test('read receipts survive a new HTTP request, editing and deletion of the cursor message', async () => {
  const first = await send(a, 'keep read');
  const last = await send(a, 'read cursor');
  await read(b, last.id);
  const edited = await call('PATCH', `/messages/${first.id}`, a, { text: 'edited after being read' });
  assert.equal(edited.data.message.readByOther, true);
  assert.equal((await find(first.id)).readByOther, true);
  await call('DELETE', `/messages/${last.id}`, a);
  assert.equal((await find(first.id)).readByOther, true);
});

test('authentication, unknown IDs and private messages cannot create a general receipt', async () => {
  const count = await GeneralReadState.countDocuments();
  assert.equal((await read(null, new mongoose.Types.ObjectId().toString())).status, 401);
  assert.equal((await read(b, 'bad')).status, 400);
  assert.equal((await read(b, new mongoose.Types.ObjectId().toString())).status, 404);
  const conversation = (await call('POST', '/conversations', a, { userId: String(bob._id) })).data.conversation;
  const privateMessage = (await call('POST', `/conversations/${conversation.id}/messages`, a, { text: 'private' })).data.message;
  assert.equal((await read(c, privateMessage.id)).status, 404);
  assert.equal(await GeneralReadState.countDocuments(), count);
});

test('the sender receives a real-time read event attributed to the authenticated reader', { timeout: 5000 }, async () => {
  const socket = io('http://localhost:8300', { auth: { token: a }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const message = await send(a, 'watch this receipt');
  const event = new Promise((resolve) => socket.once('general:read', resolve));
  const response = await call('POST', '/messages/read', b, { messageId: message.id, userId: String(alice._id) });
  const receipt = await event;
  assert.equal(response.status, 200);
  assert.equal(receipt.userId, String(bob._id));
  assert.equal(receipt.messageId, message.id);
  assert.equal((await find(message.id)).readByOther, true);
});

test('read state is restored on older pages, not just the latest page', async () => {
  const older = await send(a, 'read on an older page');
  let latest;
  for (let i = 0; i < 51; i++) latest = await send(a, `page item ${i}`);
  await read(b, latest.id);
  const firstPage = (await call('GET', '/messages', a)).data;
  assert.equal(firstPage.hasMore, true);
  const nextPage = (await call('GET', `/messages?before=${firstPage.messages[0].id}`, a)).data;
  assert.equal(nextPage.messages.find((message) => message.id === older.id).readByOther, true);
});
