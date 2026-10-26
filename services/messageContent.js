const mongoose = require('mongoose');
const multer = require('multer');
const { Message } = require('../modules/messages/message.model');
const { detectImageType } = require('./avatarStorage');
const { validateMessageInput } = require('../modules/messages/message.schema');

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function contentError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 3, fieldSize: 16 * 1024 },
}).single('attachment');

function uploadAttachment(req, res, next) {
  receive(req, res, (err) => {
    if (!err) return next();
    next(contentError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      err.code === 'LIMIT_FILE_SIZE' ? 'attachment_too_large' : 'attachment_invalid',
      'Не удалось прикрепить файл (максимум 10 МБ)'));
  });
}

async function visibleFilter(conversationId, userId) {
  if (!conversationId) return { conversation: null };
  return require('./conversationService').visibilityFilter(conversationId, userId);
}

async function prepareContent({ conversationId = null, userId, body, file }) {
  const error = validateMessageInput(body, { hasAttachment: Boolean(file) });
  if (error) throw contentError(400, error.code, error.message);
  const content = { text: (body?.text ?? '').trim(), replyTo: null };
  const replyId = body?.replyToId;
  if (replyId) {
    if (!mongoose.isValidObjectId(replyId)) throw contentError(404, 'reply_not_found', 'Сообщение для ответа недоступно');
    const filter = await visibleFilter(conversationId, userId);
    const original = await Message.findOne({ ...filter, _id: { ...filter._id, $in: [replyId] } });
    if (!original) throw contentError(404, 'reply_not_found', 'Сообщение для ответа недоступно');
    content.replyTo = original._id;
  }
  if (file) {
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const originalName = decoded.includes('\uFFFD') ? file.originalname : decoded;
    const name = originalName.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'file';
    content.attachment = {
      name,
      contentType: detectImageType(file.buffer) ?? 'application/octet-stream',
      size: file.buffer.length,
    };
    content.attachmentData = file.buffer;
  }
  return content;
}

async function getAttachment(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw contentError(404, 'attachment_not_found', 'Файл недоступен');
    const message = await Message.findById(req.params.id).select('+attachmentData');
    if (!message?.attachment || !message.attachmentData) throw contentError(404, 'attachment_not_found', 'Файл недоступен');
    if (message.conversation) {
      const conversations = require('./conversationService');
      if (!(await conversations.getForUser(message.conversation, req.user._id))) {
        throw contentError(404, 'attachment_not_found', 'Файл недоступен');
      }
      const filter = await visibleFilter(message.conversation, req.user._id);
      if (!(await Message.exists({ ...filter, _id: { ...filter._id, $in: [message._id] } }))) {
        throw contentError(404, 'attachment_not_found', 'Файл недоступен');
      }
    }
    res.set({
      'Content-Type': message.attachment.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(message.attachment.name).replace(/'/g, '%27')}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(message.attachmentData);
  } catch (err) { next(err); }
}

module.exports = { MAX_ATTACHMENT_BYTES, uploadAttachment, prepareContent, getAttachment, visibleFilter };
