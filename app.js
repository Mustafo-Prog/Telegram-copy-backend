require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./modules/messages');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { assertMailConfig } = require('./services/mailer');

const PORT = Number(process.env.PORT) || 5000;

const app = express();
app.disable('x-powered-by');
// Адреса фронтенда, которым разрешены запросы. Базовые зашиты в код,
// дополнительные можно добавить через CLIENT_ORIGIN (список через запятую).
const DEFAULT_ORIGINS = ['http://localhost:5173', 'https://telegram-copy-frontend.vercel.app'];
const EXTRA_ORIGINS = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS])];
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => res.json({ name: 'telegram-copy-backend', status: 'ok' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  if (!process.env.JWT_SECRET) {
    throw new Error('Не задан JWT_SECRET в .env');
  }
  assertMailConfig();
  await connectDB();

  const server = app.listen(PORT, () => console.log(`API: http://localhost:${PORT}`));

  const shutdown = async (signal) => {
    console.log(`${signal}: останавливаем сервер`);
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err.message);
  process.exit(1);
});
