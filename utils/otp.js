const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000; // код действует 10 минут
const MAX_ATTEMPTS = 5; // неверных попыток на один код
const RESEND_COOLDOWN_MS = 60 * 1000; // между отправками кодов на один email
const MAX_SENDS_PER_HOUR = 5; // отправок на один email за час
const RECORD_TTL_MS = 60 * 60 * 1000; // сколько хранить историю отправок

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Код хешируется с секретом сервера и адресом, поэтому утёкшая база не раскрывает коды
function hashCode(email, code) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`${email}:${code}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  MAX_SENDS_PER_HOUR,
  RECORD_TTL_MS,
  generateCode,
  hashCode,
  safeEqual,
};
