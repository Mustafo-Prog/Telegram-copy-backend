const { apiError } = require('../utils/apiError');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Возвращает нормализованный email или ошибку
function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return { error: apiError('invalid_email', 'Некорректный email') };
  }
  return { email };
}

// Код — ровно 6 цифр
function validateCode(value) {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    return apiError('code_invalid', 'Введите 6-значный код', { left: 0 });
  }
  return null;
}

module.exports = { validateEmail, validateCode };
