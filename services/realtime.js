// Socket.IO: одно соединение на вкладку, авторизация по токену, комнаты по пользователям.
// Мутации остаются в REST; сокет только доставляет события, принимать сообщения от клиента он не может.
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { User } = require('../models/User');
const { verifyToken } = require('../utils/token');
const { isAllowedOrigin } = require('../config/origins');
const presence = require('./presence');

const GENERAL_ROOM = 'general';
const WATCH_LIMIT = 50;
const userRoom = (id) => `user:${String(id)}`;

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: (origin, callback) => callback(null, isAllowedOrigin(origin)), credentials: false },
    pingInterval: 10000,
    pingTimeout: 8000,
    maxHttpBufferSize: 100 * 1024,
  });
  presence.attach(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = verifyToken(token);
      const user = await User.findById(payload.sub);
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = String(user._id);
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));
    socket.join(GENERAL_ROOM);
    presence.connected(userId, socket.id);

    socket.on('presence:activity', () => presence.activity(userId, socket.id));

    // Подписка на статусы: только видимые статусы (скрытые приходят как «hidden»)
    socket.on('presence:watch', async (payload, ack) => {
      const ids = Array.isArray(payload?.userIds)
        ? payload.userIds.filter((id) => mongoose.isValidObjectId(id)).slice(0, WATCH_LIMIT)
        : [];
      const statuses = {};
      for (const id of ids) {
        const user = await User.findById(id);
        if (!user) continue;
        socket.join(presence.presenceRoom(id));
        statuses[String(id)] = presence.visibleStatus(user);
      }
      if (typeof ack === 'function') ack({ statuses });
    });

    socket.on('presence:unwatch', (payload) => {
      const ids = Array.isArray(payload?.userIds) ? payload.userIds : [];
      for (const id of ids) {
        if (mongoose.isValidObjectId(id)) socket.leave(presence.presenceRoom(id));
      }
    });

    socket.on('disconnect', () => presence.disconnected(userId, socket.id));
  });

  return io;
}

// Событие нескольким пользователям (личные диалоги): каждому в его комнату
function toUsers(userIds, event, payload) {
  if (!io) return;
  for (const id of new Set(userIds.map((u) => String(u._id ?? u)))) {
    io.to(userRoom(id)).emit(event, payload);
  }
}

// Общий чат: видят все вошедшие пользователи
function toGeneral(event, payload) {
  if (!io) return;
  io.to(GENERAL_ROOM).emit(event, payload);
}

module.exports = { init, toUsers, toGeneral };
