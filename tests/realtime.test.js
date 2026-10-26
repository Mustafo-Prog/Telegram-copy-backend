// Socket.IO и presence: авторизация, адресная доставка, без дублей, несколько устройств,
// скрытие онлайн на сервере. Запуск: npm test
process.env.PRESENCE_GRACE_MS = '60';
process.env.PRESENCE_ACTIVE_MS = '400';
process.env.PRESENCE_SWEEP_MS = '100';
require('./helpers/setup');
process.env.PORT = '8100';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { User } = require('../models/User');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');

const ORIGIN = 'http://localhost:8100';
const BASE = ORIGIN + '/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, { token, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// Сокет с журналом всех входящих событий
function open(token) {
  return new Promise((resolve, reject) => {
    const socket = connect(ORIGIN, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    socket.log = [];
    const record = (event) => socket.on(event, (payload) => socket.log.push({ event, payload }));
    ['message:new', 'message:updated', 'message:deleted', 'chat:changed', 'presence:update'].forEach(record);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}
const count = (socket, event) => socket.log.filter((e) => e.event === event).length;
const last = (socket, event) => socket.log.filter((e) => e.event === event).at(-1)?.payload;
const watch = (socket, userIds) => new Promise((r) => socket.emit('presence:watch', { userIds }, r));
const waitFor = async (predicate, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

let ivan, anna, bob, tI, tA, tB;
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

before(async () => {
  require('../app');
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(ORIGIN + '/api/health')).ok) break; } catch {}
    await sleep(100);
  }
  ivan = await User.create({ email: 'ivan@example.com', displayName: 'Ivan', username: 'ivan_77' });
  anna = await User.create({ email: 'anna@example.com', displayName: 'Anna', username: 'anna_77' });
  bob = await User.create({ email: 'bob@example.com', displayName: 'Bob', username: 'bob_77' });
  tI = signToken(ivan); tA = signToken(anna); tB = signToken(bob);
});

after(() => { sockets.forEach((s) => s.close()); });

describe('авторизация сокетов', () => {
  it('без токена и с плохим токеном подключение отклоняется', async () => {
    await assert.rejects(open(undefined), /unauthorized/);
    await assert.rejects(open('not.a.token'), /unauthorized/);
  });
});

describe('сообщения: адресная доставка', () => {
  let conv;
  let idIvanAnna;
  it('личный диалог: отправка доходит собеседнику, отправителю и не уходит третьему', async () => {
    const sI = track(await open(tI));
    const sA = track(await open(tA));
    const sB = track(await open(tB));
    conv = (await call('POST', '/conversations', { token: tI, body: { userId: String(anna._id) } })).data.conversation.id;
    const sent = await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'привет' } });
    idIvanAnna = sent.data.message.id;
    assert.ok(await waitFor(() => count(sA, 'message:new') === 1), 'Анна получила сообщение');
    assert.equal(last(sA, 'message:new').message.text, 'привет');
    assert.ok(await waitFor(() => count(sI, 'message:new') === 1), 'отправитель получил подтверждение событием');
    await sleep(100);
    assert.equal(count(sB, 'message:new'), 0, 'посторонний не получает');
  });

  it('правка видна собеседнику сразу; без дублей', async () => {
    const sA = sockets[1];
    await call('PATCH', `/conversations/${conv}/messages/${idIvanAnna}`, { token: tI, body: { text: 'правка' } });
    assert.ok(await waitFor(() => count(sA, 'message:updated') === 1));
    assert.equal(last(sA, 'message:updated').message.text, 'правка');
  });

  it('«удалить у меня» не уходит собеседнику', async () => {
    const sI = sockets[0];
    const sA = sockets[1];
    const before = count(sA, 'message:deleted');
    await call('DELETE', `/conversations/${conv}/messages/${idIvanAnna}?mode=me`, { token: tI });
    assert.ok(await waitFor(() => count(sI, 'message:deleted') === 1), 'у меня событие пришло');
    await sleep(120);
    assert.equal(count(sA, 'message:deleted'), before, 'у собеседника события нет');
  });

  it('«удалить у всех» уходит обоим', async () => {
    const msg = (await call('POST', `/conversations/${conv}/messages`, { token: tA, body: { text: 'вторая' } })).data.message.id;
    const sI = sockets[0];
    const sA = sockets[1];
    await call('DELETE', `/conversations/${conv}/messages/${msg}?mode=everyone`, { token: tI });
    assert.ok(await waitFor(() => count(sI, 'message:deleted') >= 2));
    assert.ok(await waitFor(() => count(sA, 'message:deleted') >= 1));
  });

  it('очистка «у меня» касается только меня', async () => {
    const sI = sockets[0];
    const sA = sockets[1];
    const aBefore = count(sA, 'chat:changed');
    await call('POST', `/conversations/${conv}/clear`, { token: tI, body: { mode: 'me' } });
    assert.ok(await waitFor(() => count(sI, 'chat:changed') >= 1));
    await sleep(120);
    assert.equal(count(sA, 'chat:changed'), aBefore);
  });

  it('общий чат доходит всем, кто в сети', async () => {
    const sB = sockets[2];
    await call('POST', '/messages', { token: tA, body: { text: 'всем привет' } });
    assert.ok(await waitFor(() => last(sB, 'message:new')?.message?.text === 'всем привет'));
    assert.equal(last(sB, 'message:new').scope, 'general');
  });

  it('сокет не принимает сообщения от клиента: в базе ничего не появляется', async () => {
    const sB = sockets[2];
    const before = await Message.countDocuments({});
    sB.emit('message:new', { scope: 'general', text: 'подделка' });
    sB.emit('message:send', { text: 'подделка' });
    await sleep(150);
    assert.equal(await Message.countDocuments({}), before);
  });
});

describe('онлайн-статус', () => {
  it('подключение делает онлайн, отключение — офлайн после задержки', async () => {
    const watcher = track(await open(tB));
    const ack = await watch(watcher, [String(ivan._id)]);
    const first = track(await open(tI));
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'online'), 'стал онлайн');
    first.close();
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'offline', 2000), 'стал офлайн');
    assert.ok(ack);
  });

  it('два устройства: закрыли одно — остается онлайн', async () => {
    const watcher = track(await open(tB));
    await watch(watcher, [String(anna._id)]);
    const d1 = track(await open(tA));
    const d2 = track(await open(tA));
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'online'));
    const updates = count(watcher, 'presence:update');
    d1.close();
    await sleep(250);
    assert.equal(count(watcher, 'presence:update'), updates, 'статус не менялся');
    d2.close();
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'offline', 2000));
  });

  it('неактивное соединение дольше окна — офлайн (без закрытия сокета)', async () => {
    const watcher = track(await open(tB));
    const idle = track(await open(tI));
    const ack = await watch(watcher, [String(ivan._id)]);
    assert.equal(ack.statuses[String(ivan._id)], 'online', 'при подписке видно текущий статус');
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'offline', 2500), 'простой → офлайн');
    idle.close();
  });
});

describe('настройка «Показывать мой онлайн»', () => {
  it('скрытый онлайн не виден ни по сокету, ни по API, и не уходит как офлайн', async () => {
    const watcher = track(await open(tB));
    const r = await call('PATCH', '/users/me/privacy', { token: tI, body: { showOnlineStatus: false } });
    assert.equal(r.status, 200);
    const seen = track(await open(tI));
    const ack = await watch(watcher, [String(ivan._id)]);
    assert.equal(ack.statuses[String(ivan._id)], 'hidden', 'вместо онлайн — hidden');
    await sleep(120);
    assert.ok(!watcher.log.some((e) => e.event === 'presence:update' && e.payload.status === 'online'));
    const profile = await call('GET', '/users/ivan_77', { token: tB });
    assert.equal(profile.data.user.presence, 'hidden');
    const search = await call('GET', '/users/search?q=ivan', { token: tB });
    assert.equal(search.data.users[0].presence, 'hidden');
    seen.close();
  });

  it('скрытый пользователь продолжает получать сообщения', async () => {
    const sI = track(await open(tI));
    const conv = (await call('POST', '/conversations', { token: tA, body: { userId: String(ivan._id) } })).data.conversation.id;
    await call('POST', `/conversations/${conv}/messages`, { token: tA, body: { text: 'видно?' } });
    assert.ok(await waitFor(() => last(sI, 'message:new')?.message?.text === 'видно?'));
  });

  it('включение снова показывает реальный статус; сохраняется в базе', async () => {
    const watcher = track(await open(tB));
    await watch(watcher, [String(ivan._id)]);
    const live = track(await open(tI));
    await call('PATCH', '/users/me/privacy', { token: tI, body: { showOnlineStatus: true } });
    assert.ok(await waitFor(() => last(watcher, 'presence:update')?.status === 'online'));
    const stored = await User.findById(ivan._id);
    assert.equal(stored.privacy.showOnlineStatus, true);
    live.close();
  });

  it('неверное значение настройки отклоняется', async () => {
    const r = await call('PATCH', '/users/me/privacy', { token: tI, body: { showOnlineStatus: 'yes' } });
    assert.equal(r.status, 400);
  });
});
