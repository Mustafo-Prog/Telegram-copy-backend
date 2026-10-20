const { apiError } = require('../utils/apiError');

const MESSAGE_MAX_LENGTH = 2000;

function validateMessage(body) {
  const text = body?.text;

  if (typeof text !== 'string' || text.trim() === '') {
    return apiError('message_empty', 'Сообщение не может быть пустым');
  }
  if (text.trim().length > MESSAGE_MAX_LENGTH) {
    return apiError('message_too_long', `Сообщение не длиннее ${MESSAGE_MAX_LENGTH} символов`, {
      max: MESSAGE_MAX_LENGTH,
    });
  }
  return null;
}

module.exports = { validateMessage, MESSAGE_MAX_LENGTH };
