require('./helpers/setup');
process.env.PORT = '8400';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const { User } = require('../models/User');
const { Message } = require('../modules/messages/message.model');
const { Conversation } = require('../models/Conversation');
const { signToken } = require('../utils/token');

const BASE = 'http://localhost:8400/api';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let alice, bob, carol, dave, a, b, c, d;
const sockets = [];
async function call(method, path, token, body) {
  const multipart = body instanceof FormData;
  const response = await fetch(BASE + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  return { status: response.status, data: await response.json() };
}
const create = async (members = [bob._id], title = 'Test group') => (await call('POST', '/groups', a, { title, memberIds: members.map(String) })).data.conversation;
const send = async (id, token, text) => (await call('POST', `/conversations/${id}/messages`, token, { text })).data.message;
const list = async (token) => (await call('GET', '/conversations', token)).data.conversations;
async function connect(token) {
  const socket = io('http://localhost:8400', { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket); socket.events = [];
  for (const name of ['typing:update', 'message:new', 'chat:changed', 'preferences:changed']) socket.on(name, (data) => socket.events.push({ name, data }));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
const typing = (socket, payload) => new Promise((resolve) => socket.emit('typing:set', payload, resolve));
const latestTyping = (socket, id) => socket.events.filter((event) => event.name === 'typing:update' && event.data.conversationId === id).at(-1)?.data;
async function waitFor(check, timeout = 1800) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return true; await pause(20); }
  return check();
}

before(async () => {
  require('../app');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await pause(30); }
  [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => User.create({ email: `${name}@roadmap.test`, username: name, displayName: name })));
  [a, b, c, d] = [alice, bob, carol, dave].map(signToken);
});
after(() => sockets.forEach((socket) => socket.close()));

test('groups can be created alone or with members; duplicates are removed and private user data is excluded', async () => {
  const solo = await create([]);
  assert.equal(solo.kind, 'group'); assert.equal(solo.memberCount, 1); assert.equal(solo.ownerId, String(alice._id));
  const group = await create([bob._id, bob._id, alice._id]);
  assert.equal(group.memberCount, 2); assert.equal(group.peer, null);
  assert.deepEqual(group.adminIds, [String(alice._id)]);
  const info = (await call('GET', `/groups/${group.id}`, b)).data.group;
  assert.equal(info.members.length, 2);
  assert.ok(info.members.every((user) => user.email === undefined));
  assert.equal(info.inviteTokenHash, undefined);
  assert.equal((await list(b)).find((entry) => entry.id === group.id).title, 'Test group');
});

test('invalid names, missing users and malformed member lists are rejected', async () => {
  for (const body of [{ title: '' }, { title: 'x'.repeat(81) }, { title: 'Good', memberIds: ['bad'] },
    { title: 'Good', memberIds: 'bad' }, { title: 'Good', memberIds: [String(new mongoose.Types.ObjectId())] }]) {
    const result = await call('POST', '/groups', a, body); assert.ok([400, 404].includes(result.status));
  }
});

test('outsiders cannot read, write, search or pin a private group', async () => {
  const group = await create();
  for (const [method, path, body] of [['GET', `/groups/${group.id}`], ['GET', `/conversations/${group.id}`],
    ['GET', `/conversations/${group.id}/messages`], ['GET', `/conversations/${group.id}/search?q=secret`],
    ['POST', `/conversations/${group.id}/messages`, { text: 'intrusion' }], ['PATCH', `/conversations/${group.id}/pin`, { pinned: true }]]) {
    assert.equal((await call(method, path, c, body)).status, 404);
  }
});

test('members can send, reply and acknowledge group messages; unread state belongs to each member', async () => {
  const group = await create([bob._id, carol._id]);
  const message = await send(group.id, a, 'group hello');
  const response = await call('POST', `/conversations/${group.id}/messages`, b, { text: 'reply', replyToId: message.id });
  assert.equal(response.status, 201); assert.equal(response.data.message.replyTo.text, 'group hello');
  await call('POST', `/conversations/${group.id}/read`, b, { messageId: response.data.message.id });
  assert.equal((await list(b)).find((item) => item.id === group.id).unreadCount, 0);
  assert.equal((await list(c)).find((item) => item.id === group.id).unreadCount, 2);
  const page = (await call('GET', `/conversations/${group.id}/messages`, a)).data;
  assert.equal(page.peerLastReadMessageId, response.data.message.id);
});

test('regular members cannot manage roles, invite people, clear everyone’s history or use the direct-chat deletion endpoint', async () => {
  const group = await create();
  for (const [method, suffix, body] of [['PATCH', '', { title: 'renamed' }], ['POST', '/members', { memberIds: [String(carol._id)] }],
    ['PATCH', `/admins/${bob._id}`, { admin: true }], ['PATCH', '/owner', { userId: String(bob._id) }], ['POST', '/invite'], ['DELETE', '']]) {
    assert.equal((await call(method, `/groups/${group.id}${suffix}`, b, body)).status, 403);
  }
  assert.equal((await call('POST', `/conversations/${group.id}/clear`, b, { mode: 'both' })).status, 403);
  assert.equal((await call('DELETE', `/conversations/${group.id}`, b, { mode: 'both' })).status, 400);
});

test('admins can add members and rename a group, while ownership and other admins remain protected', async () => {
  const group = await create([bob._id, carol._id]);
  assert.equal((await call('PATCH', `/groups/${group.id}/admins/${bob._id}`, a, { admin: true })).status, 200);
  assert.equal((await call('PATCH', `/groups/${group.id}`, b, { title: 'Admin renamed' })).status, 200);
  assert.equal((await call('POST', `/groups/${group.id}/members`, b, { memberIds: [String(dave._id)] })).status, 200);
  assert.equal((await call('DELETE', `/groups/${group.id}/members/${alice._id}`, b)).status, 403);
  assert.equal((await call('PATCH', `/groups/${group.id}/admins/${carol._id}`, b, { admin: true })).status, 403);
  await call('PATCH', `/groups/${group.id}/admins/${carol._id}`, a, { admin: true });
  assert.equal((await call('DELETE', `/groups/${group.id}/members/${carol._id}`, b)).status, 403);
  assert.equal((await call('DELETE', `/groups/${group.id}/members/${dave._id}`, b)).status, 200);
});

test('ownership must be transferred before an owner can leave', async () => {
  const group = await create();
  assert.equal((await call('POST', `/groups/${group.id}/leave`, a)).data.code, 'group_transfer_required');
  const transferred = await call('PATCH', `/groups/${group.id}/owner`, a, { userId: String(bob._id) });
  assert.equal(transferred.data.conversation.ownerId, String(bob._id));
  assert.equal((await call('POST', `/groups/${group.id}/leave`, a)).status, 200);
  assert.equal((await call('GET', `/groups/${group.id}`, a)).status, 404);
  assert.equal((await call('DELETE', `/groups/${group.id}`, b)).status, 200);
});

test('invitation links are revocable, authenticated, idempotent and do not expose member data before joining', async () => {
  const group = await create([]);
  const first = (await call('POST', `/groups/${group.id}/invite`, a)).data.token;
  assert.equal(first.length, 48);
  assert.equal((await call('GET', `/groups/invites/${first}`, null)).status, 401);
  const preview = (await call('GET', `/groups/invites/${first}`, c)).data.group;
  assert.equal(preview.members, undefined); assert.equal(preview.memberCount, 1);
  const second = (await call('POST', `/groups/${group.id}/invite`, a)).data.token;
  assert.equal((await call('POST', `/groups/invites/${first}/join`, c)).status, 404);
  assert.equal((await call('POST', `/groups/invites/${second}/join`, c)).data.conversation.memberCount, 2);
  assert.equal((await call('POST', `/groups/invites/${second}/join`, c)).data.conversation.memberCount, 2);
  assert.equal((await call('GET', `/groups/${group.id}`, c)).status, 200);
});

test('simultaneous member additions cannot overwrite each other', async () => {
  const group = await create([]);
  const results = await Promise.all([bob, carol, dave].map((member) => call('POST', `/groups/${group.id}/members`, a, { memberIds: [String(member._id)] })));
  assert.ok(results.every((result) => result.status === 200));
  assert.equal((await call('GET', `/groups/${group.id}`, a)).data.group.members.length, 4);
});

test('group moderation distinguishes deleting for yourself, deleting your own and admin deletion', async () => {
  const group = await create([bob._id, carol._id]);
  const authored = await send(group.id, a, 'owner message');
  const mine = await send(group.id, b, 'member message');
  assert.equal((await call('DELETE', `/conversations/${group.id}/messages/${authored.id}?mode=everyone`, b)).status, 403);
  const bulk = await call('POST', `/conversations/${group.id}/messages/bulk-delete`, b, { ids: [authored.id, mine.id], mode: 'everyone' });
  assert.equal(bulk.data.deleted, 1); assert.equal(bulk.data.skipped, 1);
  assert.equal((await call('DELETE', `/conversations/${group.id}/messages/${authored.id}?mode=me`, c)).status, 200);
  await call('PATCH', `/groups/${group.id}/admins/${bob._id}`, a, { admin: true });
  assert.equal((await call('PATCH', `/conversations/${group.id}/messages/${authored.id}`, b, { text: 'cannot edit owner' })).status, 403);
  assert.equal((await call('DELETE', `/conversations/${group.id}/messages/${authored.id}?mode=everyone`, b)).status, 200);
});

test('removed members lose message and attachment access and receive no later group messages', async () => {
  const group = await create(); const s = await connect(b);
  const form = new FormData(); form.append('text', ''); form.append('attachment', new Blob(['group secret']), 'secret.txt');
  const attachment = (await call('POST', `/conversations/${group.id}/messages`, a, form)).data.message.attachment;
  assert.equal((await fetch(BASE + attachment.url, { headers: { Authorization: `Bearer ${b}` } })).status, 200);
  await call('DELETE', `/groups/${group.id}/members/${bob._id}`, a);
  const before = s.events.filter((event) => event.name === 'message:new' && event.data.conversationId === group.id).length;
  await send(group.id, a, 'after removal'); await pause(80);
  assert.equal(s.events.filter((event) => event.name === 'message:new' && event.data.conversationId === group.id).length, before);
  assert.equal((await fetch(BASE + attachment.url, { headers: { Authorization: `Bearer ${b}` } })).status, 404);
  assert.equal((await call('GET', `/conversations/${group.id}/messages`, b)).status, 404);
  assert.ok(!(await list(b)).some((item) => item.id === group.id));
});

test('pins persist per user and keep old chats above newer unpinned chats', async () => {
  const old = await create([], 'Old pinned');
  const recent = await create([], 'New unpinned'); await send(recent.id, a, 'latest');
  assert.equal((await call('PATCH', `/conversations/${old.id}/pin`, a, { pinned: true })).status, 200);
  const mine = await list(a); assert.equal(mine[0].id, old.id); assert.ok(mine[0].pinnedAt);
  await call('POST', `/groups/${old.id}/members`, a, { memberIds: [String(bob._id)] });
  assert.equal((await list(b)).find((entry) => entry.id === old.id).pinnedAt, null);
  await call('PATCH', `/conversations/${old.id}/pin`, a, { pinned: false });
  assert.equal((await list(a)).find((entry) => entry.id === old.id).pinnedAt, null);
  const general = await call('PATCH', '/users/me/general-pin', a, { pinned: true });
  assert.ok(general.data.user.generalPinnedAt);
  assert.ok((await call('GET', '/auth/me', a)).data.user.generalPinnedAt);
  assert.equal((await call('GET', '/users/alice', b)).data.user.generalPinnedAt, undefined);
});

test('search covers the full history, uses literal case-insensitive matching and paginates without duplicates', async () => {
  const group = await create();
  const old = await send(group.id, a, 'Needle [x] from older history');
  for (let index = 0; index < 65; index++) await send(group.id, a, `searchable item ${index}`);
  const first = await call('GET', `/conversations/${group.id}/search?q=needle%20%5Bx%5D`, b);
  assert.equal(first.data.messages[0].id, old.id);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=%5Bx%5D`, b)).data.messages.length, 1);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=.*`, b)).data.messages.length, 0);
  const page = (await call('GET', `/conversations/${group.id}/search?q=searchable`, b)).data;
  assert.equal(page.messages.length, 30); assert.equal(page.hasMore, true);
  const older = (await call('GET', `/conversations/${group.id}/search?q=searchable&before=${page.messages.at(-1).id}`, b)).data;
  assert.equal(new Set([...page.messages, ...older.messages].map((message) => message.id)).size, 60);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=a`, b)).status, 400);
});

test('search respects hidden messages and cleared history and also searches attachment filenames', async () => {
  const group = await create(); const message = await send(group.id, a, 'hiddenneedle');
  await call('DELETE', `/conversations/${group.id}/messages/${message.id}?mode=me`, b);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=hiddenneedle`, b)).data.messages.length, 0);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=hiddenneedle`, a)).data.messages.length, 1);
  const form = new FormData(); form.append('text', ''); form.append('attachment', new Blob(['report']), 'Budget-2026.txt');
  await call('POST', `/conversations/${group.id}/messages`, a, form);
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=budget`, b)).data.messages.length, 1);
  await call('POST', `/conversations/${group.id}/clear`, b, { mode: 'me' });
  assert.equal((await call('GET', `/conversations/${group.id}/search?q=budget`, b)).data.messages.length, 0);
  await call('POST', '/messages', a, { text: 'public searchable' });
  assert.ok((await call('GET', '/messages/search?q=public', c)).data.messages.some((item) => item.text === 'public searchable'));
});

test('voice messages retain validated audio type and duration, while disguised or invalid recordings are rejected', async () => {
  const make = (content, duration = 1200) => { const form = new FormData(); form.append('text', ''); form.append('voiceDurationMs', String(duration)); form.append('attachment', new Blob([content], { type: 'audio/ogg' }), 'voice.ogg'); return form; };
  const header = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(12)]);
  const result = await call('POST', '/messages', a, make(header));
  assert.equal(result.status, 201); assert.equal(result.data.message.attachment.kind, 'voice');
  assert.equal(result.data.message.attachment.contentType, 'audio/ogg'); assert.equal(result.data.message.attachment.durationMs, 1200);
  for (const form of [make('<script>bad</script>'), make(header, -1), make(header, 180001), make(header, 'NaN')]) {
    const rejected = await call('POST', '/messages', a, form); assert.equal(rejected.status, 400); assert.equal(rejected.data.code, 'voice_invalid');
  }
});

test('typing is authenticated, restricted to the chat audience and cannot impersonate a different user', { timeout: 6000 }, async () => {
  const group = await create(); const sa = await connect(a); const sb = await connect(b); const sc = await connect(c);
  const payload = { scope: 'conversation', conversationId: group.id, active: true, userId: String(alice._id), displayName: 'spoof' };
  assert.equal((await typing(sb, payload)).ok, true);
  assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active));
  assert.equal(latestTyping(sa, group.id).userId, String(bob._id)); assert.equal(latestTyping(sa, group.id).displayName, 'bob');
  await pause(60); assert.equal(latestTyping(sc, group.id), undefined);
  assert.equal((await typing(sc, payload)).ok, false);
  await typing(sb, { ...payload, active: false });
  assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active === false));
});

test('typing stops on disconnect and immediately disappears when online privacy is hidden', { timeout: 6000 }, async () => {
  const group = await create(); const sa = await connect(a); const sb = await connect(b);
  const payload = { scope: 'conversation', conversationId: group.id, active: true };
  await typing(sb, payload); assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active));
  sb.close(); assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active === false));
  const next = await connect(b); await typing(next, payload); assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active));
  await call('PATCH', '/users/me/privacy', b, { showOnlineStatus: false });
  assert.ok(await waitFor(() => latestTyping(sa, group.id)?.active === false));
  await call('PATCH', '/users/me/privacy', b, { showOnlineStatus: true });
});

test('native group schema validation keeps direct chats at two members and groups within their member limit', async () => {
  await new Conversation({ kind: 'group', title: 'Valid', owner: alice._id, admins: [alice._id], participants: [alice._id], directKey: 'group:validation' }).validate();
  await assert.rejects(new Conversation({ participants: [alice._id, bob._id, carol._id], directKey: 'direct-invalid' }).validate(), (error) => error.name === 'ValidationError' && Boolean(error.errors.participants));
  await assert.rejects(new Conversation({ kind: 'group', participants: [], directKey: 'group-invalid' }).validate(), (error) => error.name === 'ValidationError' && Boolean(error.errors.participants));
});
