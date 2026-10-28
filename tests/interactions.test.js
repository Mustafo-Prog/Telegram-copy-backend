require('./helpers/setup');
process.env.PORT = '8600';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');
const BASE = 'http://localhost:8600/api';
let alice, bob, carol, outsider, a, b, c, d;
const sockets = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, token, body) {
  const response = await fetch(BASE + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const group = async () => (await call('POST', '/groups', a, { title: 'Readers and reactions', memberIds: [String(bob._id), String(carol._id)] })).data.conversation;
const send = async (id, token = a) => (await call('POST', `/conversations/${id}/messages`, token, { text: 'Hello group' })).data.message;
const readers = (id, token = a) => call('GET', `/messages/${id}/readers`, token);
const react = (id, token, emoji = '👍', active = true) => call('PUT', `/messages/${id}/reactions`, token, { emoji, active });
const read = (id, messageId, token) => call('POST', `/conversations/${id}/read`, token, { messageId });

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await pause(30); }
  [alice, bob, carol, outsider] = await Promise.all(['alice', 'bob', 'carol', 'outsider'].map((name) => User.create({ email: `${name}@interactions.test`, displayName: name })));
  [a, b, c, d] = [alice, bob, carol, outsider].map(signToken);
});
after(() => sockets.forEach((socket) => socket.close()));

test('group readers identify other members through their persisted cursor, without marking newer messages or exposing private profiles', async () => {
  const chat = await group(); const first = await send(chat.id); const second = await send(chat.id);
  assert.deepEqual((await readers(first.id)).data.readers, []);
  await read(chat.id, second.id, a);
  assert.deepEqual((await readers(first.id)).data.readers, []);
  await read(chat.id, first.id, b);
  assert.deepEqual((await readers(first.id)).data.readers.map((user) => user.id), [String(bob._id)]);
  assert.deepEqual((await readers(second.id)).data.readers, []);
  await read(chat.id, second.id, c);
  const seen = (await readers(first.id)).data.readers;
  assert.deepEqual(seen.map((user) => user.id), [String(bob._id), String(carol._id)]);
  assert.ok(seen.every((user) => !Object.hasOwn(user, 'email') && !Object.hasOwn(user, 'privacy')));
  await read(chat.id, second.id, b); await read(chat.id, first.id, b);
  assert.equal((await readers(second.id)).data.readers.length, 2);
});

test('readers require authentication, authorship, group membership and a visible message', async () => {
  const chat = await group(); const message = await send(chat.id);
  assert.equal((await readers(message.id, null)).status, 401);
  assert.equal((await readers(message.id, b)).status, 403);
  assert.equal((await readers(message.id, d)).status, 404);
  assert.equal((await readers('bad-id')).status, 404);
  const direct = (await call('POST', '/conversations', a, { userId: String(bob._id) })).data.conversation;
  assert.equal((await readers((await send(direct.id)).id)).status, 403);
  await call('POST', `/conversations/${chat.id}/clear`, a, { mode: 'me' });
  assert.equal((await readers(message.id)).status, 404);
});

test('the general chat lists actual readers while excluding the author', async () => {
  const message = (await call('POST', '/messages', a, { text: 'General readership' })).data.message;
  await call('POST', '/messages/read', a, { messageId: message.id });
  await call('POST', '/messages/read', b, { messageId: message.id });
  const result = await readers(message.id);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.readers.map((user) => user.id), [String(bob._id)]);
});

test('reactions persist in history and edits; add/remove retries never duplicate or remove another user’s reaction', async () => {
  const chat = await group(); const message = await send(chat.id);
  await react(message.id, a); await react(message.id, a); await react(message.id, b);
  let result = (await react(message.id, c, '❤️')).data;
  assert.equal(result.reactions.find((entry) => entry.emoji === '👍').count, 2);
  await react(message.id, a, '👍', false); result = (await react(message.id, a, '👍', false)).data;
  assert.deepEqual(result.reactions.find((entry) => entry.emoji === '👍').userIds, [String(bob._id)]);
  await call('PATCH', `/conversations/${chat.id}/messages/${message.id}`, a, { text: 'Edited text' });
  const stored = (await call('GET', `/conversations/${chat.id}/messages`, a)).data.messages.find((entry) => entry.id === message.id);
  assert.deepEqual(stored.reactions, result.reactions);
  assert.equal(stored.reactionsVersion, result.reactionsVersion);
});

test('concurrent reaction updates preserve both users and return monotonic versions', async () => {
  const chat = await group(); const message = await send(chat.id);
  const results = await Promise.all([react(message.id, a), react(message.id, b), react(message.id, c, '🔥')]);
  assert.deepEqual(results.map((result) => result.data.reactionsVersion).sort(), [1, 2, 3]);
  const stored = (await call('GET', `/conversations/${chat.id}/messages`, a)).data.messages[0];
  assert.equal(stored.reactions.find((entry) => entry.emoji === '👍').count, 2);
  assert.equal(stored.reactions.find((entry) => entry.emoji === '🔥').count, 1);
});

test('invalid, hidden, cleared, deleted and foreign messages cannot receive reactions', async () => {
  const chat = await group(); const message = await send(chat.id);
  assert.equal((await react(message.id, null)).status, 401);
  assert.equal((await react(message.id, d)).status, 404);
  assert.equal((await react(message.id, a, '<script>')).status, 400);
  assert.equal((await react(message.id, a, '👍', 'true')).status, 400);
  await call('DELETE', `/conversations/${chat.id}/messages/${message.id}?mode=me`, b);
  assert.equal((await react(message.id, b)).status, 404);
  await call('POST', `/conversations/${chat.id}/clear`, c, { mode: 'me' });
  assert.equal((await react(message.id, c)).status, 404);
  await call('DELETE', `/conversations/${chat.id}/messages/${message.id}?mode=everyone`, a);
  assert.equal((await react(message.id, a)).status, 404);
});

test('reaction socket events reach group members but never outsiders; removed members lose access', { timeout: 6000 }, async () => {
  const chat = await group(); const message = await send(chat.id);
  const connect = (token) => new Promise((resolve, reject) => {
    const socket = io('http://localhost:8600', { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket); socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
  });
  const [memberSocket, outsiderSocket] = await Promise.all([connect(b), connect(d)]);
  const leaked = []; outsiderSocket.on('message:reactions', (payload) => leaked.push(payload));
  const event = new Promise((resolve) => memberSocket.once('message:reactions', resolve));
  await react(message.id, a, '🎉');
  const payload = await event;
  assert.equal(payload.conversationId, chat.id); assert.equal(payload.messageId, message.id);
  assert.equal(payload.reactions[0].emoji, '🎉');
  await call('DELETE', `/groups/${chat.id}/members/${bob._id}`, a);
  assert.equal((await react(message.id, b)).status, 404);
  await react(message.id, c); await pause(80);
  assert.equal(leaked.length, 0);
});

test('native message validation rejects unsupported reaction emoji and malformed user IDs', async () => {
  await assert.rejects(new Message({ sender: alice._id, text: 'test', reactions: [{ user: bob._id, emoji: 'bad' }] }).validate());
  await assert.rejects(new Message({ sender: alice._id, text: 'test', reactions: [{ user: 'bad', emoji: '👍' }] }).validate());
  await new Message({ sender: alice._id, text: 'test', reactions: [{ user: bob._id, emoji: '👍' }] }).validate();
});
