const nodemailer = require('nodemailer');

const MAIL_TIMEOUT_MS = 10000;
let transporter = null;

// Render (и многие бесплатные хостинги) блокируют исходящий SMTP,
// поэтому в продакшене письма отправляются через HTTP-API Brevo.
async function sendViaBrevo(to, subject, text) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: 'Telegram Copy' },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Brevo ${response.status}: ${await response.text()}`);
  }
}

function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS,
    });
  }
  return transporter;
}

async function sendRegisterCode(to, code, ttlMinutes) {
  const subject = `Код подтверждения: ${code}`;
  const text = `Ваш код подтверждения: ${code}\nКод действует ${ttlMinutes} минут. Если вы не регистрировались, просто проигнорируйте письмо.`;

  if (process.env.BREVO_API_KEY) {
    return sendViaBrevo(to, subject, text);
  }
  if (process.env.SMTP_HOST) {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    return;
  }
  // Ни один провайдер не настроен: код печатается в консоль сервера (только для разработки)
  console.log(`[DEV] Код подтверждения для ${to}: ${code} (действует ${ttlMinutes} мин)`);
}

module.exports = { sendRegisterCode };
