require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./modules/messages');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const PORT = Number(process.env.PORT) || 5000;

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  if (!process.env.JWT_SECRET) {
    throw new Error('Не задан JWT_SECRET в .env');
  }
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
