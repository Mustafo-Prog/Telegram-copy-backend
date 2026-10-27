require('./helpers/setup');
process.env.PORT = '8500';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { Conversation } = require('../models/Conversation');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');
const BASE = 'http://localhost:8500/api';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let alice, bob, a, b;
const sockets = [];

async function call(method, path, token, body) {
  const multipart = body instanceof FormData;
  const response = await fetch(BASE + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  return { status: response.status, data: await response.json() };
}
const open = async (token = a) => (await call('POST', '/conversations/saved', token)).data.conversation;
const save = (id, token = a) => call('POST', `/conversations/saved/messages/${id}`, token);
const send = async (id, token, text) => (await call('POST', `/conversations/${id}/messages`, token, { text })).data.message;
const direct = async () => (await call('POST', '/conversations', a, { userId: String(bob._id) })).data.conversation;

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await pause(30); }
  [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => User.create({ email: `${name}@saved.test`, displayName: name })));
  [a, b] = [alice, bob].map(signToken);
});
after(() => sockets.forEach((socket) => socket.close()));

test('saved schema requires exactly one participant and no group owner', async () => {
  const fields = { kind: 'saved', participants: [alice._id], directKey: `saved:${alice._id}` };
  await new Conversation(fields).validate();
  await assert.rejects(new Conversation({ ...fields, participants: [alice._id, bob._id] }).validate());
  await assert.rejects(new Conversation({ ...fields, participants: [] }).validate());
});

test('opening saved messages is authenticated and idempotent for each owner', async () => {
  assert.equal((await call('POST', '/conversations/saved', null)).status, 401);
  const saved = await open();
  assert.equal(saved.kind, 'saved'); assert.equal(saved.memberCount, 1); assert.equal(saved.peer, null);
  assert.equal(saved.peerLastReadMessageId, null); assert.equal(saved.unreadCount, 0);
  assert.equal(saved.id, (await open()).id); assert.notEqual(saved.id, (await open(b)).id);
  assert.equal((await call('POST', '/conversations', a, { userId: String(alice._id) })).data.code, 'cannot_message_self');
});

test('saved notes support ordinary send, edit, reply, search, pagination and pins without unread counts', async () => {
  const saved = await open();
  const note = await send(saved.id, a, 'saved needle');
  assert.equal(note.senderId, String(alice._id)); assert.equal(note.senderName, 'alice');
  assert.equal((await call('PATCH', `/conversations/${saved.id}/messages/${note.id}`, a, { text: 'edited needle' })).status, 200);
  const reply = await call('POST', `/conversations/${saved.id}/messages`, a, { text: 'reply', replyToId: note.id });
  assert.equal(reply.data.message.replyTo.text, 'edited needle');
  assert.equal((await call('GET', `/conversations/${saved.id}/search?q=needle`, a)).data.messages[0].id, note.id);
  const pin = await call('PATCH', `/conversations/${saved.id}/pin`, a, { pinned: true });
  assert.equal(pin.data.conversation.id, saved.id); assert.ok(pin.data.conversation.pinnedAt);
  const dto = (await call('GET', '/conversations', a)).data.conversations.find((entry) => entry.id === saved.id);
  assert.equal(dto.lastMessageId, reply.data.message.id); assert.equal(dto.unreadCount, 0);
  const page = (await call('GET', `/conversations/${saved.id}/messages?before=${reply.data.message.id}`, a)).data;
  assert.ok(page.messages.some((message) => message.id === note.id)); assert.equal(page.peerLastReadMessageId, null);
});

test('other users cannot read, write, search, pin, modify or fetch files in saved messages', async () => {
  const saved = await open();
  const note = await send(saved.id, a, 'private saved note');
  for (const [method, suffix, body] of [['GET', ''], ['GET', '/messages'], ['GET', '/search?q=private'],
    ['POST', '/messages', { text: 'intrusion' }], ['PATCH', '/pin', { pinned: true }], ['POST', '/read', { messageId: note.id }],
    ['PATCH', `/messages/${note.id}`, { text: 'intrusion' }], ['DELETE', `/messages/${note.id}`], ['DELETE', '']]) {
    assert.equal((await call(method, `/conversations/${saved.id}${suffix}`, b, body)).status, 404);
  }
  assert.equal((await save(note.id, b)).status, 404);
  assert.equal((await call('GET', '/conversations', b)).data.conversations.some((entry) => entry.id === saved.id), false);
});

test('saving a visible message creates an independent snapshot including author and timestamp', async () => {
  const conversation = await direct();
  const original = await send(conversation.id, b, 'keep this message');
  const result = await save(original.id);
  assert.equal(result.status, 201); assert.equal(result.data.conversation.kind, 'saved');
  const copy = result.data.message;
  assert.notEqual(copy.id, original.id); assert.equal(copy.senderId, String(alice._id));
  assert.equal(copy.text, original.text); assert.deepEqual(copy.savedFrom, { senderName: 'bob', createdAt: original.createdAt });
  await call('DELETE', `/conversations/${conversation.id}/messages/${original.id}?mode=everyone`, b);
  assert.ok((await call('GET', `/conversations/${result.data.conversation.id}/messages`, a)).data.messages.some((message) => message.id === copy.id));
});

test('saving files copies protected binary content and voice metadata, independently of the source', async () => {
  const conversation = await direct();
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8);
  const form = new FormData(); form.append('text', 'voice caption'); form.append('voiceDurationMs', '1');
  form.append('attachment', new Blob([wav], { type: 'audio/wav' }), 'note.wav');
  const original = (await call('POST', `/conversations/${conversation.id}/messages`, b, form)).data.message;
  const result = await save(original.id); assert.equal(result.status, 201);
  const copy = result.data.message;
  assert.equal(copy.attachment.kind, 'voice'); assert.equal(copy.attachment.durationMs, 1);
  assert.notEqual(copy.attachment.url, original.attachment.url);
  await call('DELETE', `/conversations/${conversation.id}/messages/${original.id}?mode=everyone`, b);
  const response = await fetch(BASE + copy.attachment.url, { headers: { Authorization: `Bearer ${a}` } });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  assert.equal((await fetch(BASE + copy.attachment.url, { headers: { Authorization: `Bearer ${b}` } })).status, 404);
});

test('messages hidden, cleared, deleted or in a foreign conversation cannot be saved', async () => {
  const conversation = await direct();
  const hidden = await send(conversation.id, b, 'hidden');
  await call('DELETE', `/conversations/${conversation.id}/messages/${hidden.id}?mode=me`, a);
  assert.equal((await save(hidden.id)).status, 404);
  const cleared = await send(conversation.id, b, 'cleared');
  await call('POST', `/conversations/${conversation.id}/clear`, a, { mode: 'me' });
  assert.equal((await save(cleared.id)).status, 404);
  assert.equal((await save('bad')).status, 404);
  assert.equal((await save(String(new mongoose.Types.ObjectId()))).status, 404);
});

test('saving a general message sends the private saved event only to its owner', async () => {
  const connect = async (token) => {
    const socket = io('http://localhost:8500', { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket); socket.messages = [];
    socket.on('message:new', (event) => socket.messages.push(event));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  const [owner, other] = await Promise.all([connect(a), connect(b)]);
  const original = (await call('POST', '/messages', b, { text: 'public save' })).data.message;
  const result = await save(original.id); await pause(50);
  assert.equal(result.status, 201);
  assert.ok(owner.messages.some((event) => event.message.id === result.data.message.id));
  assert.ok(!other.messages.some((event) => event.message.id === result.data.message.id));
  assert.equal((await Message.findById(result.data.message.id)).replyTo, null);
});

test('send correlation IDs are validated and retained for text and multipart messages', async () => {
  const saved = await open();
  const result = await call('POST', `/conversations/${saved.id}/messages`, a, { text: 'instant echo', clientMessageId: 'local-123' });
  assert.equal(result.data.message.clientMessageId, 'local-123');
  assert.equal(sockets[0].messages.at(-1).message.clientMessageId, 'local-123');
  for (const clientMessageId of ['', 'x'.repeat(81), 123, null]) {
    assert.equal((await call('POST', `/conversations/${saved.id}/messages`, a, { text: 'invalid', clientMessageId })).status, 400);
  }
  const form = new FormData(); form.append('text', ''); form.append('clientMessageId', 'multipart-123');
  form.append('attachment', new Blob(['notes']), 'notes.txt');
  assert.equal((await call('POST', '/messages', a, form)).data.message.clientMessageId, 'multipart-123');
});
