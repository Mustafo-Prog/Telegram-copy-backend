const { User } = require('../models/User');
const { LoginCode } = require('../models/LoginCode');
const { signToken } = require('../utils/token');
const { apiError } = require('../utils/apiError');
const { validateEmail, validateCode } = require('../schemas/authSchemas');
const otp = require('../utils/otp');
const { sendLoginCode } = require('../services/mailer');

const DISPLAY_NAME_MAX_LENGTH = 50;
const ONE_HOUR_MS = 60 * 60 * 1000;

// Шаг 1: отправить код на email.
// Ответ одинаковый, есть ли пользователь с таким email — не выдаём, кто зарегистрирован.
async function requestCode(req, res, next) {
  try {
    const { email, error } = validateEmail(req.body?.email);
    if (error) return res.status(400).json(error);

    const now = Date.now();
    const record = await LoginCode.findOne({ email });
    const recentSends = (record?.sentAt ?? [])
      .map((d) => d.getTime())
      .filter((t) => now - t < ONE_HOUR_MS);

    const lastSend = recentSends.at(-1);
    if (lastSend && now - lastSend < otp.RESEND_COOLDOWN_MS) {
      const seconds = Math.ceil((otp.RESEND_COOLDOWN_MS - (now - lastSend)) / 1000);
      return res.status(429).json(apiError('code_cooldown', 'Подождите перед новым запросом кода', { seconds }));
    }
    if (recentSends.length >= otp.MAX_SENDS_PER_HOUR) {
      return res.status(429).json(apiError('code_rate_limited', 'Слишком много запросов кода'));
    }

    const code = otp.generateCode();
    const previous = record
      ? { codeHash: record.codeHash, codeExpiresAt: record.codeExpiresAt, attempts: record.attempts }
      : { codeHash: null, codeExpiresAt: null, attempts: 0 };
    await LoginCode.findOneAndUpdate(
      { email },
      {
        email,
        codeHash: otp.hashCode(email, code),
        codeExpiresAt: new Date(now + otp.CODE_TTL_MS),
        attempts: 0,
        sentAt: [...recentSends, now].slice(-otp.MAX_SENDS_PER_HOUR).map((t) => new Date(t)),
        expiresAt: new Date(now + otp.RECORD_TTL_MS),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendLoginCode(email, code);
    } catch (mailErr) {
      console.error('[mail] не удалось отправить код:', mailErr.code ?? '', mailErr.message);
      // Письмо не ушло: откатываем запись, чтобы не блокировать повторную попытку кулдауном
      await LoginCode.findOneAndUpdate(
        { email },
        { ...previous, sentAt: recentSends.map((t) => new Date(t)) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return res.status(502).json(apiError('mail_failed', 'Не удалось отправить код, попробуйте позже'));
    }

    res.json({ ok: true, cooldown: otp.RESEND_COOLDOWN_MS / 1000 });
  } catch (err) {
    next(err);
  }
}

// Шаг 2: проверить код и выдать токен. Новый email автоматически создаёт аккаунт.
async function verifyCode(req, res, next) {
  try {
    const { email, error } = validateEmail(req.body?.email);
    if (error) return res.status(400).json(error);

    const codeError = validateCode(req.body?.code);
    if (codeError) return res.status(400).json(codeError);

    const record = await LoginCode.findOne({ email });
    if (!record || !record.codeHash) {
      return res.status(400).json(apiError('code_expired', 'Срок действия кода истёк'));
    }
    if (record.codeExpiresAt.getTime() < Date.now()) {
      return res.status(400).json(apiError('code_expired', 'Срок действия кода истёк'));
    }
    if (record.attempts >= otp.MAX_ATTEMPTS) {
      return res.status(429).json(apiError('code_attempts_exceeded', 'Слишком много неверных попыток'));
    }

    const isValid = otp.safeEqual(record.codeHash, otp.hashCode(email, req.body.code));
    if (!isValid) {
      record.attempts += 1;
      await record.save();
      const left = otp.MAX_ATTEMPTS - record.attempts;
      if (left <= 0) {
        return res.status(429).json(apiError('code_attempts_exceeded', 'Слишком много неверных попыток'));
      }
      return res.status(400).json(apiError('code_invalid', 'Неверный код', { left }));
    }

    // Код одноразовый: сразу гасим его
    record.codeHash = null;
    record.codeExpiresAt = null;
    record.attempts = 0;
    await record.save();

    const user = await findOrCreateUser(email);
    res.json({ token: signToken(user), user: user.toPublic() });
  } catch (err) {
    next(err);
  }
}

async function findOrCreateUser(email) {
  const existing = await User.findOne({ email });
  if (existing) return existing;
  try {
    return await User.create({
      email,
      displayName: email.split('@')[0].slice(0, DISPLAY_NAME_MAX_LENGTH),
    });
  } catch (err) {
    // Параллельный вход с тем же email создал пользователя раньше
    if (err.code === 11000) return User.findOne({ email });
    throw err;
  }
}

function me(req, res) {
  res.json({ user: req.user.toPublic() });
}

module.exports = { requestCode, verifyCode, me };
