const { apiError } = require('../utils/apiError');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_BYTES = 72;
const DISPLAY_NAME_MAX_LENGTH = 50;

function isValidEmail(email) {
  return typeof email === 'string' && email.trim().length <= 254 && EMAIL_RE.test(email.trim());
}

function validateRegister(body) {
  const { email, password, displayName } = body ?? {};

  if (!isValidEmail(email)) {
    return apiError('invalid_email', 'Некорректный email');
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return apiError('password_too_short', `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`, {
      min: PASSWORD_MIN_LENGTH,
    });
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return apiError('password_too_long', `Пароль слишком длинный (максимум ${PASSWORD_MAX_BYTES} байт)`, {
      max: PASSWORD_MAX_BYTES,
    });
  }
  if (
    displayName != null &&
    (typeof displayName !== 'string' || displayName.trim().length > DISPLAY_NAME_MAX_LENGTH)
  ) {
    return apiError('name_invalid', `Имя должно быть строкой не длиннее ${DISPLAY_NAME_MAX_LENGTH} символов`, {
      max: DISPLAY_NAME_MAX_LENGTH,
    });
  }
  return null;
}

function validateLogin(body) {
  const { email, password } = body ?? {};

  if (typeof email !== 'string' || email.trim() === '' || typeof password !== 'string' || password === '') {
    return apiError('credentials_required', 'Введите email и пароль');
  }
  return null;
}

module.exports = { validateRegister, validateLogin };
