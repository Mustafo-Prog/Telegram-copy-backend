// Адреса фронтенда, которым разрешено читать ответы API и подключаться по WebSocket.
// Базовый список + CLIENT_ORIGIN (через запятую) + шаблоны Vercel и localhost.
const DEFAULT_ORIGINS = ['http://localhost:5173', 'https://telegram-copy-frontend.vercel.app'];

const EXTRA_ORIGINS = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS])];

const ALLOWED_PATTERNS = [
  /^https:\/\/telegram-copy-frontend(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // запросы не из браузера (curl, сервер-сервер)
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_PATTERNS.some((pattern) => pattern.test(origin));
}

module.exports = { isAllowedOrigin };
