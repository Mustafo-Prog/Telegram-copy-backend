const { apiError } = require('../../utils/apiError');

const MESSAGE_MAX_LENGTH = 2000;

function validateMessageInput(body, { hasAttachment = false } = {}) {
  const text = body?.text;

  if ((text !== undefined && typeof text !== 'string') || (!hasAttachment && !text?.trim())) {
    return apiError('message_empty', 'Сообщение не может быть пустым');
  }
  if ((text ?? '').trim().length > MESSAGE_MAX_LENGTH) {
    return apiError('message_too_long', `Сообщение не длиннее ${MESSAGE_MAX_LENGTH} символов`, {
      max: MESSAGE_MAX_LENGTH,
    });
  }
  return null;
}

module.exports = { validateMessageInput, MESSAGE_MAX_LENGTH };
