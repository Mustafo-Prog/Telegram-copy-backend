// Presence: кто сейчас в сети. Источник правды — сервер.
// Онлайн, пока есть хотя бы одно активное соединение (несколько вкладок и устройств).
// Offline — когда соединений не осталось (после короткой задержки на перезагрузку страницы)
// или когда все соединения неактивны дольше ACTIVE_WINDOW_MS.
const { User } = require('../models/User');

const ACTIVE_WINDOW_MS = Number(process.env.PRESENCE_ACTIVE_MS) || 5 * 60 * 1000;
const GRACE_MS = Number(process.env.PRESENCE_GRACE_MS) || 3000;
const SWEEP_MS = Number(process.env.PRESENCE_SWEEP_MS) || 30 * 1000;

let io = null;
const sockets = new Map(); // userId -> Map(socketId -> lastActivityMs)
const lastRaw = new Map(); // userId -> 'online' | 'offline' (что уже разослано)
const graceTimers = new Map();
const lastActivity = new Map();

const presenceRoom = (userId) => `presence:${String(userId)}`;

function attach(server) {
  io = server;
  const timer = setInterval(sweep, SWEEP_MS);
  if (timer.unref) timer.unref();
}

function rawOnline(userId) {
  const map = sockets.get(String(userId));
  if (!map || map.size === 0) return false;
  const now = Date.now();
  for (const last of map.values()) {
    if (now - last < ACTIVE_WINDOW_MS) return true;
  }
  return false;
}

// Что видит другой пользователь. Если статус скрыт — «hidden», а не «offline»:
// иначе скрытый онлайн выглядел бы как офлайн и вводил в заблуждение
function visibleStatus(user) {
  if (user.privacy?.showOnlineStatus === false) return 'hidden';
  return rawOnline(user._id) ? 'online' : 'offline';
}

function visiblePresence(user) {
  const status = visibleStatus(user);
  return {
    status,
    lastSeenAt: status === 'offline' && user.lastSeenAt ? new Date(user.lastSeenAt).toISOString() : null,
  };
}

async function rememberActivity(userId, timestamp) {
  // Atomic maximum keeps delayed writes from moving the timestamp backwards.
  await User.updateOne({ _id: userId }, { $max: { lastSeenAt: new Date(timestamp) } });
}

async function emitStatus(userId) {
  if (!io) return;
  const user = await User.findById(userId);
  if (!user) return;
  io.to(presenceRoom(userId)).emit('presence:update', { userId: String(userId), ...visiblePresence(user) });
}

async function publishIfChanged(userId) {
  const now = rawOnline(userId) ? 'online' : 'offline';
  if (lastRaw.get(userId) === now) return;
  lastRaw.set(userId, now);
  if (now === 'offline' && lastActivity.has(userId)) await rememberActivity(userId, lastActivity.get(userId));
  await emitStatus(userId);
}

function connected(userId, socketId) {
  const id = String(userId);
  if (!sockets.has(id)) sockets.set(id, new Map());
  const now = Date.now();
  sockets.get(id).set(socketId, now);
  lastActivity.set(id, now);
  if (graceTimers.has(id)) {
    clearTimeout(graceTimers.get(id));
    graceTimers.delete(id);
  }
  return rememberActivity(id, now).then(() => publishIfChanged(id));
}

function activity(userId, socketId) {
  const map = sockets.get(String(userId));
  if (!map || !map.has(socketId)) return Promise.resolve();
  const id = String(userId);
  const now = Date.now();
  map.set(socketId, now);
  lastActivity.set(id, now);
  return rememberActivity(id, now).then(() => publishIfChanged(id));
}

function disconnected(userId, socketId) {
  const id = String(userId);
  const map = sockets.get(id);
  if (!map) return Promise.resolve();
  if (rawOnline(id)) lastActivity.set(id, Date.now());
  map.delete(socketId);
  if (map.size > 0) return Promise.resolve();

  sockets.delete(id);
  // Короткая задержка: перезагрузка страницы не должна мигать «offline»
  const timer = setTimeout(() => {
    graceTimers.delete(id);
    publishIfChanged(id).catch((err) => console.error('Presence:', err.message));
  }, GRACE_MS);
  graceTimers.set(id, timer);
  return Promise.resolve();
}

// Смена настройки конфиденциальности: сразу пересылаем видимый статус
function privacyChanged(userId) {
  return emitStatus(userId);
}

function sweep() {
  for (const userId of [...sockets.keys()]) publishIfChanged(userId).catch((err) => console.error('Presence:', err.message));
}

module.exports = {
  attach,
  connected,
  activity,
  disconnected,
  visibleStatus,
  visiblePresence,
  privacyChanged,
  presenceRoom,
  rawOnline,
  ACTIVE_WINDOW_MS,
  GRACE_MS,
};
