process.env.PRESENCE_GRACE_MS = '30';
require('./helpers/setup');
process.env.PORT = '8200';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');
const presence = require('../services/presence');
const BASE = 'http://localhost:8200/api';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let alice, bob, outsider, a, b, c;
const sockets = [];

async function request(method, path, token, body) {
  const multipart = body instanceof FormData;
  const response = await fetch(BASE + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  return { status: response.status, data: await response.json() };
}
const open = async (token, peer) => (await request('POST', '/conversations', token, { userId: String(peer._id) })).data.conversation.id;
const send = async (conv, token, text, extra = {}) => request('POST', `/conversations/${conv}/messages`, token, { text, ...extra });
const list = async (token) => (await request('GET', '/conversations', token)).data.conversations;
function form(text = '', name = 'notes.txt', content = 'a private file', type = 'text/plain') {
  const data = new FormData();
  data.append('text', text);
  data.append('attachment', new Blob([content], { type }), name);
  return data;
}
async function socket(token) {
  const s = io('http://localhost:8200', { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
  return s;
}

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await pause(30);
  }
  alice = await User.create({ email: 'alice@example.com', displayName: 'Alice', username: 'alice' });
  bob = await User.create({ email: 'bob@example.com', displayName: 'Bob', username: 'bob' });
  outsider = await User.create({ email: 'eve@example.com', displayName: 'Eve', username: 'eve' });
  a = signToken(alice); b = signToken(bob); c = signToken(outsider);
});
after(() => sockets.forEach((s) => s.close()));

test('last seen survives disconnect and includes an ISO timestamp in API and subscriptions', async () => {
  const started = Date.now();
  await presence.connected(bob._id, 'test-last-seen');
  await presence.activity(bob._id, 'test-last-seen');
  presence.disconnected(bob._id, 'test-last-seen');
  await pause(80);
  const saved = await User.findById(bob._id);
  assert.ok(new Date(saved.lastSeenAt).getTime() >= started);
  const profile = (await request('GET', '/users/bob', a)).data.user;
  assert.equal(profile.presence, 'offline');
  assert.equal(profile.lastSeenAt, new Date(saved.lastSeenAt).toISOString());
  const s = await socket(a);
  const ack = await new Promise((resolve) => s.emit('presence:watch', { userIds: [String(bob._id)] }, resolve));
  assert.equal(ack.lastSeen[String(bob._id)], profile.lastSeenAt);
});

test('privacy removes last seen from profiles, search, conversations, subscriptions and events', async () => {
  const conv = await open(a, bob);
  const s = sockets[0];
  const update = new Promise((resolve) => s.once('presence:update', resolve));
  assert.equal((await request('PATCH', '/users/me/privacy', b, { showOnlineStatus: false })).status, 200);
  const event = await update;
  assert.equal(event.status, 'hidden'); assert.equal(event.lastSeenAt, null);
  const profile = (await request('GET', '/users/bob', a)).data.user;
  assert.equal(profile.lastSeenAt, null);
  const found = (await request('GET', '/users/search?q=bo', a)).data.users[0];
  assert.equal(found.lastSeenAt, null);
  assert.equal((await list(a)).find((x) => x.id === conv).peer.lastSeenAt, null);
  const ack = await new Promise((resolve) => s.emit('presence:watch', { userIds: [String(bob._id)] }, resolve));
  assert.equal(ack.statuses[String(bob._id)], 'hidden');
  assert.equal(ack.lastSeen[String(bob._id)], null);
  await request('PATCH', '/users/me/privacy', b, { showOnlineStatus: true });
});

test('read receipts are monotonic, delivered to participants and update unread counts', async () => {
  const conv = await open(a, bob);
  const first = (await send(conv, a, 'first unread')).data.message.id;
  const second = (await send(conv, a, 'second unread')).data.message.id;
  assert.equal((await list(b)).find((x) => x.id === conv).unreadCount, 2);
  assert.equal((await list(a)).find((x) => x.id === conv).unreadCount, 0);
  const s = sockets[0];
  const receipt = new Promise((resolve) => s.once('conversation:read', resolve));
  const result = await request('POST', `/conversations/${conv}/read`, b, { messageId: second });
  assert.equal(result.status, 200);
  assert.equal((await receipt).userId, String(bob._id));
  await request('POST', `/conversations/${conv}/read`, b, { messageId: first });
  assert.equal((await list(b)).find((x) => x.id === conv).unreadCount, 0);
  const page = (await request('GET', `/conversations/${conv}/messages`, a)).data;
  assert.equal(page.peerLastReadMessageId, second);
  await send(conv, a, 'new after read');
  assert.equal((await list(b)).find((x) => x.id === conv).unreadCount, 1);
});

test('an outsider or a message from another chat cannot forge a read receipt', async () => {
  const conv = await open(a, bob);
  const foreign = await open(a, outsider);
  const messageId = (await send(foreign, a, 'foreign')).data.message.id;
  assert.equal((await request('POST', `/conversations/${conv}/read`, c, { messageId })).status, 404);
  assert.equal((await request('POST', `/conversations/${conv}/read`, b, { messageId })).status, 404);
  assert.equal((await request('POST', `/conversations/${conv}/read`, b, { messageId: 'bad' })).status, 400);
});

test('hidden messages and cleared history do not count as unread', async () => {
  const conv = await open(b, outsider);
  const message = (await send(conv, c, 'hide this')).data.message;
  await request('DELETE', `/conversations/${conv}/messages/${message.id}?mode=me`, b);
  assert.equal((await list(b)).find((x) => x.id === conv).unreadCount, 0);
  assert.equal((await request('POST', `/conversations/${conv}/read`, b, { messageId: message.id })).status, 404);
  await send(conv, c, 'clear this');
  await request('POST', `/conversations/${conv}/clear`, b, { mode: 'me' });
  assert.equal((await list(b)).find((x) => x.id === conv).unreadCount, 0);
});

test('replies quote the source and never quote a different chat or hidden message', async () => {
  const conv = await open(a, bob);
  const original = (await send(conv, b, 'original private text')).data.message;
  const reply = await send(conv, a, 'answer', { replyToId: original.id });
  assert.equal(reply.data.message.replyTo.text, original.text);
  assert.equal(reply.data.message.replyTo.senderName, 'Bob');
  const foreign = await open(a, outsider);
  assert.equal((await send(foreign, a, 'leak?', { replyToId: original.id })).status, 404);
  await request('DELETE', `/conversations/${conv}/messages/${original.id}?mode=me`, a);
  assert.equal((await send(conv, a, 'hidden?', { replyToId: original.id })).status, 404);
  const mine = (await request('GET', `/conversations/${conv}/messages`, a)).data.messages.find((m) => m.id === reply.data.message.id);
  assert.equal(mine.replyTo.unavailable, true);
  assert.equal(mine.replyTo.text, undefined);
  const theirs = (await request('GET', `/conversations/${conv}/messages`, b)).data.messages.find((m) => m.id === reply.data.message.id);
  assert.equal(theirs.replyTo.text, original.text);
});

test('deleting an original for everyone removes the quote text for both participants', async () => {
  const conv = await open(a, bob);
  const original = (await send(conv, a, 'delete original')).data.message;
  const reply = (await send(conv, b, 'reply', { replyToId: original.id })).data.message;
  await request('DELETE', `/conversations/${conv}/messages/${original.id}?mode=everyone`, a);
  for (const token of [a, b]) {
    const page = (await request('GET', `/conversations/${conv}/messages`, token)).data;
    assert.deepEqual(page.messages.find((m) => m.id === reply.id).replyTo, { id: original.id, unavailable: true });
  }
});

test('file-only messages preserve Unicode names and do not expose binary content in DTOs', async () => {
  const conv = await open(a, bob);
  const response = await request('POST', `/conversations/${conv}/messages`, a, form('', 'заметки.txt'));
  assert.equal(response.status, 201);
  const message = response.data.message;
  assert.equal(message.text, '');
  assert.equal(message.attachment.name, 'заметки.txt');
  assert.equal(message.attachmentData, undefined);
  const download = await fetch(BASE + message.attachment.url, { headers: { Authorization: `Bearer ${b}` } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'a private file');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await list(b)).find((x) => x.id === conv).lastMessageText, 'заметки.txt');
});

test('attachments require authentication, chat membership and visibility', async () => {
  const conv = await open(a, bob);
  const message = (await request('POST', `/conversations/${conv}/messages`, a, form())).data.message;
  for (const token of [null, c]) {
    const response = await fetch(BASE + message.attachment.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, token ? 404 : 401);
  }
  await request('DELETE', `/conversations/${conv}/messages/${message.id}?mode=me`, b);
  assert.equal((await fetch(BASE + message.attachment.url, { headers: { Authorization: `Bearer ${b}` } })).status, 404);
  assert.equal((await fetch(BASE + message.attachment.url, { headers: { Authorization: `Bearer ${a}` } })).status, 200);
  await request('DELETE', `/conversations/${conv}/messages/${message.id}?mode=everyone`, a);
  assert.equal((await fetch(BASE + message.attachment.url, { headers: { Authorization: `Bearer ${a}` } })).status, 404);
});

test('a claimed image MIME type cannot turn HTML content into an inline image', async () => {
  const response = await request('POST', '/messages', a, form('', 'image.png', '<script>alert(1)</script>', 'image/png'));
  assert.equal(response.status, 201);
  assert.equal(response.data.message.attachment.contentType, 'application/octet-stream');
});

test('files over 10 MB are rejected before a message is created', async () => {
  const count = await Message.countDocuments();
  const response = await request('POST', '/messages', a, form('', 'large.bin', new Uint8Array(10 * 1024 * 1024 + 1)));
  assert.equal(response.status, 413);
  assert.equal(response.data.code, 'attachment_too_large');
  assert.equal(await Message.countDocuments(), count);
});

test('a caption can be edited without removing the attachment', async () => {
  const message = (await request('POST', '/messages', a, form('caption'))).data.message;
  const response = await request('PATCH', `/messages/${message.id}`, a, { text: '' });
  assert.equal(response.status, 200);
  assert.equal(response.data.message.text, '');
  assert.equal(response.data.message.attachment.name, 'notes.txt');
});

test('real Mongoose validation allows file-only messages but rejects empty text messages', async () => {
  const attachment = { name: 'file.txt', contentType: 'application/octet-stream', size: 4 };
  await new Message({ sender: alice._id, text: '', attachment, attachmentData: Buffer.from('test') }).validate();
  await assert.rejects(new Message({ sender: alice._id, text: '' }).validate(), /required/);
  await assert.rejects(new Message({ sender: alice._id, text: 'x'.repeat(2001) }).validate(), /maximum allowed length/);
});
