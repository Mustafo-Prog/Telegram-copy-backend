const nodemailer = require('nodemailer');

// Обычный SMTP через nodemailer. Настройки — в переменных окружения:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// MAIL_MODE=console — для локальных тестов: письма не отправляются, код выводится в консоль.

function isConsoleMode() {
  return process.env.MAIL_MODE === 'console';
}

function createTransporter() {
  if (isConsoleMode()) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 — SSL сразу, 587 — STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function assertMailConfig() {
  if (isConsoleMode()) return;
  for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) {
    if (!process.env[name]) throw new Error(`Не задан ${name} в .env`);
  }
}

const transporter = createTransporter();

async function sendLoginCode(to, code) {
  const text = [
    `Ваш код входа: ${code}`,
    `Kirish kodingiz: ${code}`,
    `Your sign-in code: ${code}`,
    '',
    'Код действует 10 минут. / Kod 10 daqiqa amal qiladi. / The code is valid for 10 minutes.',
  ].join('\n');

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `Код входа: ${code}`,
    text,
  });

  if (isConsoleMode()) {
    console.log(`[mail:console] код для ${to}: ${code}`);
  }
  return info;
}

module.exports = { sendLoginCode, assertMailConfig };
