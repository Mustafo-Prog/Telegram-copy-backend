const nodemailer = require('nodemailer');

// Письма отправляет nodemailer. Транспорт — HTTP API Brevo:
// это обычный HTTPS-запрос, поэтому работает на бесплатном Render (SMTP-порты там закрыты).
// Переменные: BREVO_API_KEY (ключ API Brevo), MAIL_FROM (подтверждённый адрес отправителя).
// MAIL_MODE=console — для локальных тестов: письма не отправляются, код выводится в консоль.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15000;

function isConsoleMode() {
  return process.env.MAIL_MODE === 'console';
}

// "Telegram Clone <mailer@x.com>" -> { name, email }; "mailer@x.com" -> { email }
function parseSender(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].replace(/^"|"$/g, '').trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return { email: text };
}

function createBrevoTransport() {
  return nodemailer.createTransport({
    name: 'brevo-http',
    version: '1.0.0',
    send(mail, callback) {
      const { from, to, subject, text, html } = mail.data;
      fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: parseSender(from),
          to: [{ email: to }],
          subject,
          textContent: text,
          htmlContent: html,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(`Brevo ${res.status}: ${data.message || 'request failed'}`);
          }
          callback(null, { messageId: data.messageId });
        })
        .catch((err) => callback(err));
    },
  });
}

function createConsoleTransport() {
  return nodemailer.createTransport({ jsonTransport: true });
}

const transporter = isConsoleMode() ? createConsoleTransport() : createBrevoTransport();

function assertMailConfig() {
  if (isConsoleMode()) return;
  for (const name of ['BREVO_API_KEY', 'MAIL_FROM']) {
    if (!process.env[name]) throw new Error(`Не задан ${name} в .env`);
  }
}

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
    html: `<p>${text.split('\n').join('<br>')}</p>`,
  });

  if (isConsoleMode()) {
    console.log(`[mail:console] код для ${to}: ${code}`);
  }
  return info;
}

module.exports = { sendLoginCode, assertMailConfig, parseSender };
