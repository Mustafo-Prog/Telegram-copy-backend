const mongoose = require('mongoose');
const dns = require('dns');

const DEFAULT_DNS_SERVERS = ['8.8.8.8', '8.8.4.4', '9.9.9.9'];

function applyDnsServers() {
  const custom = (process.env.DNS_SERVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  dns.setServers(custom.length ? custom : DEFAULT_DNS_SERVERS);
}

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('Не задан MONGODB_URI в .env');
  }
  applyDnsServers();
  mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));

  try {
    await mongoose.connect(uri);
  } catch (err) {
    throw new Error(
      `Не удалось подключиться к MongoDB: ${err.message}. ` +
        'Проверьте MONGODB_URI, доступ сети к кластеру (IP в Network Access Atlas) и при необходимости DNS_SERVERS.'
    );
  }
  console.log('MongoDB connected');
}

module.exports = connectDB;
