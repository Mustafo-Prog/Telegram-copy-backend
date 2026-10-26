require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./modules/messages');
const userRoutes = require('./routes/userRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { assertMailConfig } = require('./services/mailer');
const { isAllowedOrigin } = require('./config/origins');
const http = require('http');
const realtime = require('./services/realtime');

const PORT = Number(process.env.PORT) || 5000;

const app = express();
const httpServer = http.createServer(app);
realtime.init(httpServer);
app.disable('x-powered-by');
app.use(cors({ origin: (origin, callback) => callback(null, isAllowedOrigin(origin)) }));
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => res.json({ name: 'telegram-copy-backend', status: 'ok' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/groups', require('./routes/groupRoutes'));

app.use(notFound);
app.use(errorHandler);

async function start() {
  if (!process.env.JWT_SECRET) {
    throw new Error('Не задан JWT_SECRET в .env');
  }
  assertMailConfig();
  await connectDB();

  const server = httpServer.listen(PORT, () => console.log(`API: http://localhost:${PORT}`));

  const shutdown = async (signal) => {
    console.log(`${signal}: останавливаем сервер`);
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { app, httpServer };

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err.message);
  process.exit(1);
});
