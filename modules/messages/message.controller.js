const mongoose = require('mongoose');
const realtime = require('../../services/realtime');
const messageService = require('./message.service');
const { toMessageDto, presentMessages, presentMessage } = require('./message.presenter');
const { prepareContent } = require('../../services/messageContent');
const generalReads = require('../../services/generalReadService');
const { Message } = require('./message.model');
const { apiError } = require('../../utils/apiError');

async function list(req, res, next) {
  try {
    const before = mongoose.isValidObjectId(req.query.before) ? String(req.query.before) : undefined;
    const docs = await messageService.listRecentMessages({ before });
    res.json({
      messages: await presentMessages(docs, req.user._id),
      hasMore: docs.length === messageService.PAGE_SIZE,
    });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const content = await prepareContent({ userId: req.user._id, body: req.body, file: req.file });

    const message = await messageService.createMessage({
      senderId: req.user._id,
      ...content,
    });
    const dto = toMessageDto(message);
    realtime.toGeneral('message:new', { scope: 'general', message: dto });
    res.status(201).json({ message: await presentMessage(message, req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    const messageId = req.body?.messageId;
    if (!mongoose.isValidObjectId(messageId)) {
      return res.status(400).json(apiError('ids_invalid', 'Некорректное сообщение'));
    }
    if (!(await Message.exists({ _id: messageId, conversation: null }))) {
      return res.status(404).json(apiError('message_not_found', 'Сообщение недоступно'));
    }
    const state = await generalReads.markRead(req.user._id, messageId);
    const payload = { userId: String(req.user._id), messageId: String(state.lastReadMessageId) };
    realtime.toGeneral('general:read', payload);
    res.json(payload);
  } catch (err) { next(err); }
}

module.exports = { list, create, markRead };
