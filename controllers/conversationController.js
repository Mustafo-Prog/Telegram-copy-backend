const mongoose = require('mongoose');
const { User } = require('../models/User');
const conversations = require('../services/conversationService');
const { toMessageDto } = require('../modules/messages/message.presenter');
const { validateMessageInput } = require('../modules/messages/message.schema');
const { apiError } = require('../utils/apiError');
const realtime = require('../services/realtime');

function fail(res, status, code, message) {
  return res.status(status).json(apiError(code, message));
}

async function listConversations(req, res, next) {
  try {
    res.json({ conversations: await conversations.listDtosForUser(req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function openConversation(req, res, next) {
  try {
    const peerId = req.body?.userId;
    if (!mongoose.isValidObjectId(peerId)) return fail(res, 404, 'user_not_found', 'Пользователь не найден');
    if (String(peerId) === String(req.user._id)) {
      return fail(res, 400, 'cannot_message_self', 'Нельзя написать самому себе');
    }

    const peer = await User.exists({ _id: peerId });
    if (!peer) return fail(res, 404, 'user_not_found', 'Пользователь не найден');

    const conversation = await conversations.findOrCreateDirect(req.user._id, peerId);
    await conversations.unhideFor(conversation._id, req.user._id);
    res.json({ conversation: await conversations.getDtoForUser(conversation._id, req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function listMessages(req, res, next) {
  try {
    const conversation = await conversations.getForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');

    const before = mongoose.isValidObjectId(req.query.before) ? req.query.before : undefined;
    const docs = await conversations.listMessages(conversation._id, req.user._id, { before });
    res.json({ messages: docs.map(toMessageDto), hasMore: docs.length === conversations.PAGE_SIZE });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    const conversation = await conversations.getForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');

    const error = validateMessageInput(req.body);
    if (error) return res.status(400).json(error);

    const message = await conversations.createMessage(conversation, req.user._id, req.body.text.trim());
    const dto = toMessageDto(message);
    realtime.toUsers(conversation.participants, 'message:new', {
      scope: 'conversation',
      conversationId: String(conversation._id),
      message: dto,
    });
    res.status(201).json({ message: dto });
  } catch (err) {
    if (err.status) return res.status(err.status).json(apiError(err.code, err.message));
    next(err);
  }
}

module.exports = { listConversations, openConversation, listMessages, sendMessage };
