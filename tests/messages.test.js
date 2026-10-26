// Тесты ФУИ: права, редактирование, удаление, очистка, превью, пакеты, пагинация и гонки.
// Запуск: npm test
require('./helpers/setup');
process.env.PORT = '7000';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { User } = require('../models/User');
const { Conversation } = require('../models/Conversation');
const { Message } = require('../modules/messages/message.model');
const { signToken } = require('../utils/token');

const BASE = 'http://localhost:7000/api';
const call = async (method, path, { token, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const texts = (list) => list.map((m) => m.text);
const tick = () => new Promise((r) => setTimeout(r, 4));

let ivan, anna, bob, tI, tA, tB;

before(async () => {
  require('../app');
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`http://localhost:7000/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  ivan = await User.create({ email: 'ivan@example.com', displayName: 'Ivan', username: 'ivan_77' });
  anna = await User.create({ email: 'anna@example.com', displayName: 'Anna', username: 'anna_77' });
  bob = await User.create({ email: 'bob@example.com', displayName: 'Bob', username: 'bob_77' });
  tI = signToken(ivan); tA = signToken(anna); tB = signToken(bob);
});

describe('общий чат', () => {
  let mine, theirs;
  it('без токена доступа нет', async () => {
    assert.equal((await call('GET', '/messages')).status, 401);
  });
  it('редактировать можно только свои; текст и отметка обновляются у всех', async () => {
    mine = (await call('POST', '/messages', { token: tI, body: { text: 'первое' } })).data.message.id;
    theirs = (await call('POST', '/messages', { token: tA, body: { text: 'чужое' } })).data.message.id;
    let r = await call('PATCH', `/messages/${mine}`, { token: tI, body: { text: '  первое (правка)  ' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.message.text, 'первое (правка)');
    assert.ok(r.data.message.editedAt);
    r = await call('GET', '/messages', { token: tA });
    assert.equal(r.data.messages.find((m) => m.id === mine).text, 'первое (правка)');
    r = await call('PATCH', `/messages/${theirs}`, { token: tI, body: { text: 'взлом' } });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'forbidden');
  });
  it('чужое в общем нельзя удалить; свое — можно и исчезает у всех', async () => {
    assert.equal((await call('DELETE', `/messages/${theirs}`, { token: tI })).status, 403);
    assert.equal((await call('DELETE', `/messages/${mine}`, { token: tI })).status, 200);
    const r = await call('GET', '/messages', { token: tA });
    assert.ok(!r.data.messages.some((m) => m.id === mine));
  });
  it('массовое: свои удаляются, чужие пропускаются со счетчиком', async () => {
    const a = (await call('POST', '/messages', { token: tI, body: { text: 'пакет-1' } })).data.message.id;
    const b = (await call('POST', '/messages', { token: tI, body: { text: 'пакет-2' } })).data.message.id;
    const r = await call('POST', '/messages/bulk-delete', { token: tI, body: { ids: [a, b, theirs] } });
    assert.equal(r.data.deleted, 2);
    assert.equal(r.data.skipped, 1);
    const after = await call('GET', '/messages', { token: tA });
    assert.ok(texts(after.data.messages).includes('чужое'));
  });
  it('лимит пакета: 101 — отказ с кодом too_many_ids, 100 — принимается', async () => {
    const r101 = await call('POST', '/messages/bulk-delete', { token: tI, body: { ids: new Array(101).fill(theirs) } });
    assert.equal(r101.status, 400);
    assert.equal(r101.data.code, 'too_many_ids');
    // 100 разных id (несуществующих для меня): принимается, все пропущены
    const ids100 = Array.from({ length: 100 }, () => new mongoose.Types.ObjectId().toString());
    const r100 = await call('POST', '/messages/bulk-delete', { token: tI, body: { ids: ids100 } });
    assert.equal(r100.status, 200);
    assert.equal(r100.data.deleted, 0);
    assert.equal(r100.data.skipped, 100);
  });
  it('режим «у меня» в общем чате запрещён; неверные id — ids_invalid', async () => {
    let r = await call('POST', '/messages/bulk-delete', { token: tI, body: { ids: [theirs], mode: 'me' } });
    assert.equal(r.data.code, 'mode_not_allowed');
    r = await call('POST', '/messages/bulk-delete', { token: tI, body: { ids: ['bad'] } });
    assert.equal(r.data.code, 'ids_invalid');
  });
});

describe('личный диалог: права и режимы', () => {
  let conv, d1, d2, d3;
  it('открыть диалог; повторно — тот же самый', async () => {
    const r1 = await call('POST', '/conversations', { token: tI, body: { userId: String(anna._id) } });
    conv = r1.data.conversation.id;
    const r2 = await call('POST', '/conversations', { token: tA, body: { userId: String(ivan._id) } });
    assert.equal(r2.data.conversation.id, conv);
    assert.equal(r1.data.conversation.peer.email, undefined);
  });
  it('себе нельзя; несуществующий и неверный id — 404', async () => {
    assert.equal((await call('POST', '/conversations', { token: tI, body: { userId: String(ivan._id) } })).data.code, 'cannot_message_self');
    assert.equal((await call('POST', '/conversations', { token: tI, body: { userId: 'bad' } })).status, 404);
  });
  it('сообщения идут в диалог, не в общий чат', async () => {
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'd1' } }); await tick();
    await call('POST', `/conversations/${conv}/messages`, { token: tA, body: { text: 'd2' } }); await tick();
    const r = await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'd3' } });
    d3 = r.data.message.id;
    const general = await call('GET', '/messages', { token: tI });
    assert.ok(!texts(general.data.messages).includes('d1'));
    const list = await call('GET', `/conversations/${conv}/messages`, { token: tA });
    d1 = list.data.messages.find((m) => m.text === 'd1').id;
    d2 = list.data.messages.find((m) => m.text === 'd2').id;
  });
  it('«у меня» скрывает только у меня', async () => {
    assert.equal((await call('DELETE', `/conversations/${conv}/messages/${d1}?mode=me`, { token: tI })).status, 200);
    let r = await call('GET', `/conversations/${conv}/messages`, { token: tI });
    assert.ok(!texts(r.data.messages).includes('d1'));
    r = await call('GET', `/conversations/${conv}/messages`, { token: tA });
    assert.ok(texts(r.data.messages).includes('d1'));
  });
  it('полученное можно удалить «у всех» — исчезает у обоих', async () => {
    assert.equal((await call('DELETE', `/conversations/${conv}/messages/${d2}?mode=everyone`, { token: tI })).status, 200);
    for (const t of [tI, tA]) {
      const r = await call('GET', `/conversations/${conv}/messages`, { token: t });
      assert.ok(!texts(r.data.messages).includes('d2'));
    }
  });
  it('редактировать чужое нельзя; свое — видно собеседнику сразу', async () => {
    assert.equal((await call('PATCH', `/conversations/${conv}/messages/${d3}`, { token: tA, body: { text: 'x' } })).status, 403);
    assert.equal((await call('PATCH', `/conversations/${conv}/messages/${d3}`, { token: tI, body: { text: 'd3 правка' } })).status, 200);
    const r = await call('GET', `/conversations/${conv}/messages`, { token: tA });
    const seen = r.data.messages.find((m) => m.id === d3);
    assert.equal(seen.text, 'd3 правка');
    assert.ok(seen.editedAt);
  });
  it('посторонний не видит и не трогает диалог', async () => {
    assert.equal((await call('GET', `/conversations/${conv}/messages`, { token: tB })).status, 404);
    assert.equal((await call('DELETE', `/conversations/${conv}/messages/${d3}?mode=everyone`, { token: tB })).status, 404);
    assert.equal((await call('DELETE', `/conversations/${conv}`, { token: tB, body: { mode: 'both' } })).status, 404);
  });
});

describe('превью диалога считается для каждого пользователя', () => {
  it('после «удалить у меня» текст не остается в превью у меня, у собеседника остается', async () => {
    const r = await call('POST', '/conversations', { token: tI, body: { userId: String(bob._id) } });
    const conv = r.data.conversation.id;
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'старое' } }); await tick();
    const last = await call('POST', `/conversations/${conv}/messages`, { token: tB, body: { text: 'секрет' } });
    const id = last.data.message.id;
    await call('DELETE', `/conversations/${conv}/messages/${id}?mode=me`, { token: tI });
    const mine = (await call('GET', '/conversations', { token: tI })).data.conversations.find((c) => c.id === conv);
    assert.equal(mine.lastMessageText, 'старое', 'у меня превью — последнее видимое');
    const theirs = (await call('GET', '/conversations', { token: tB })).data.conversations.find((c) => c.id === conv);
    assert.equal(theirs.lastMessageText, 'секрет', 'у собеседника превью не меняется');
  });
});

describe('очистка и удаление чата', () => {
  let conv;
  let carl;
  let tC;
  before(async () => {
    // Отдельный собеседник, чтобы не смешивать историю с предыдущими тестами
    carl = await User.create({ email: 'carl@example.com', displayName: 'Carl', username: 'carl_77' });
    tC = signToken(carl);
    conv = (await call('POST', '/conversations', { token: tI, body: { userId: String(carl._id) } })).data.conversation.id;
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'h1' } }); await tick();
    await call('POST', `/conversations/${conv}/messages`, { token: tC, body: { text: 'h2' } }); await tick();
  });
  it('очистка «у меня»: у меня пусто, у собеседника цело; новое видно', async () => {
    assert.equal((await call('POST', `/conversations/${conv}/clear`, { token: tI, body: { mode: 'me' } })).status, 200);
    await tick();
    let r = await call('GET', `/conversations/${conv}/messages`, { token: tI });
    assert.equal(r.data.messages.length, 0);
    r = await call('GET', `/conversations/${conv}/messages`, { token: tC });
    assert.deepEqual(texts(r.data.messages), ['h1', 'h2']);
    await call('POST', `/conversations/${conv}/messages`, { token: tC, body: { text: 'n1' } });
    r = await call('GET', `/conversations/${conv}/messages`, { token: tI });
    assert.deepEqual(texts(r.data.messages), ['n1']);
  });
  it('очистка «для обоих»: у всех пусто; режим everyone для очистки запрещен', async () => {
    assert.equal((await call('POST', `/conversations/${conv}/clear`, { token: tI, body: { mode: 'everyone' } })).data.code, 'mode_not_allowed');
    assert.equal((await call('POST', `/conversations/${conv}/clear`, { token: tC, body: { mode: 'both' } })).status, 200);
    for (const t of [tI, tC]) {
      const r = await call('GET', `/conversations/${conv}/messages`, { token: t });
      assert.equal(r.data.messages.length, 0);
    }
  });
  it('удалить чат «у меня» скрывает; новое сообщение возвращает его без старой истории', async () => {
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'before-hide' } }); await tick();
    assert.equal((await call('DELETE', `/conversations/${conv}`, { token: tC, body: { mode: 'me' } })).status, 200);
    let r = await call('GET', '/conversations', { token: tC });
    assert.ok(!r.data.conversations.some((c) => c.id === conv));
    await tick();
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'again' } }); await tick();
    r = await call('GET', '/conversations', { token: tC });
    assert.ok(r.data.conversations.some((c) => c.id === conv));
    r = await call('GET', `/conversations/${conv}/messages`, { token: tC });
    assert.deepEqual(texts(r.data.messages), ['again']);
  });
  it('удалить чат «для обоих» стирает всё; повторное общение — с чистого листа', async () => {
    assert.equal((await call('DELETE', `/conversations/${conv}`, { token: tI, body: { mode: 'both' } })).status, 200);
    assert.equal(await Message.countDocuments({ conversation: conv }), 0);
    assert.equal(await Conversation.countDocuments({ _id: conv }), 0);
    const fresh = (await call('POST', '/conversations', { token: tC, body: { userId: String(ivan._id) } })).data.conversation.id;
    assert.notEqual(fresh, conv);
    const r = await call('GET', `/conversations/${fresh}/messages`, { token: tI });
    assert.equal(r.data.messages.length, 0);
  });
});

describe('пагинация и согласованность', () => {
  it('120 сообщений: страницы по 50, без дублей, в порядке времени', async () => {
    const conv = (await call('POST', '/conversations', { token: tI, body: { userId: String(bob._id) } })).data.conversation.id;
    for (let i = 1; i <= 120; i++) await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: `m${i}` } });
    const first = await call('GET', `/conversations/${conv}/messages`, { token: tB });
    assert.equal(first.data.messages.length, 50);
    assert.equal(first.data.hasMore, true);
    assert.equal(first.data.messages.at(-1).text, 'm120');
    const second = await call('GET', `/conversations/${conv}/messages?before=${first.data.messages[0].id}`, { token: tB });
    assert.equal(second.data.messages.at(-1).text, 'm70');
    const all = [...second.data.messages, ...first.data.messages].map((m) => m.text);
    assert.equal(new Set(all).size, all.length, 'дублей нет');
    assert.deepEqual(all.slice(0, 3), ['m21', 'm22', 'm23'], 'порядок по времени');
  });
  it('редактирование и удаление видны при повторном запросе (синхронизация опросом)', async () => {
    const conv = (await call('POST', '/conversations', { token: tI, body: { userId: String(bob._id) } })).data.conversation.id;
    const m = (await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'sync' } })).data.message.id;
    await call('PATCH', `/conversations/${conv}/messages/${m}`, { token: tI, body: { text: 'sync2' } });
    let r = await call('GET', `/conversations/${conv}/messages`, { token: tB });
    assert.equal(r.data.messages.find((x) => x.id === m).text, 'sync2');
    await call('DELETE', `/conversations/${conv}/messages/${m}?mode=everyone`, { token: tB });
    r = await call('GET', `/conversations/${conv}/messages`, { token: tI });
    assert.ok(!r.data.messages.some((x) => x.id === m));
  });
  it('отправка во время удаления чата «для обоих» не оставляет сиротских сообщений', async () => {
    const conv = (await call('POST', '/conversations', { token: tI, body: { userId: String(bob._id) } })).data.conversation.id;
    await call('POST', `/conversations/${conv}/messages`, { token: tI, body: { text: 'seed' } });
    const [send, drop] = await Promise.all([
      call('POST', `/conversations/${conv}/messages`, { token: tB, body: { text: 'гонка' } }),
      call('DELETE', `/conversations/${conv}`, { token: tI, body: { mode: 'both' } }),
    ]);
    assert.ok([201, 404].includes(send.status), 'отправка либо прошла, либо получила 404');
    assert.equal(drop.status, 200);
    assert.equal(await Message.countDocuments({ conversation: conv }), 0, 'сиротских сообщений нет');
  });
});

describe('общий чат: постраничная загрузка', () => {
  it('страницы без дублей и пропусков; вместе дают все сообщения', async () => {
    for (let i = 1; i <= 60; i++) await call('POST', '/messages', { token: tA, body: { text: `g${i}` } });
    const seen = [];
    let r = await call('GET', '/messages', { token: tI });
    assert.equal(r.data.messages.length, 50);
    assert.equal(r.data.hasMore, true);
    seen.push(...r.data.messages.map((m) => m.id));
    while (r.data.hasMore) {
      const oldest = r.data.messages[0].id;
      r = await call('GET', `/messages?before=${oldest}`, { token: tI });
      seen.unshift(...r.data.messages.map((m) => m.id));
    }
    assert.equal(new Set(seen).size, seen.length, 'дубликатов нет');
    const total = await Message.countDocuments({ conversation: null });
    assert.equal(seen.length, total, 'пропусков нет');
    // порядок: по времени отправки (возрастание)
    const all = (await call('GET', '/messages', { token: tI })).data.messages;
    assert.equal(all.at(-1).text, 'g60');
  });
});
