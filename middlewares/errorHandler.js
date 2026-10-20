const { apiError } = require('../utils/apiError');

function notFound(_req, res) {
  res.status(404).json(apiError('not_found', 'Не найдено'));
}

function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(apiError('invalid_json', 'Некорректный JSON'));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(apiError('payload_too_large', 'Слишком большой запрос'));
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json(apiError('invalid_data', 'Некорректные данные'));
  }

  console.error(err);
  res.status(500).json(apiError('internal', 'Внутренняя ошибка сервера'));
}

module.exports = { notFound, errorHandler };
