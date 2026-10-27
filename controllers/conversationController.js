const mongoose = require('mongoose');
const { User } = require('../models/User');
const conversations = require('../services/conversationService');
const { toMessageDto, presentMessages, presentMessage } = require('../modules/messages/message.presenter');
const { prepareContent } = require('../services/messageContent');
const { ConversationState } = require('../models/ConversationState');
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
    res.json({ messages: await presentMessages(docs, req.user._id), hasMore: docs.length === conversations.PAGE_SIZE,
      peerLastReadMessageId: await conversations.peerReadCursor(conversation, req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    const conversation = await conversations.getForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');

    const content = await prepareContent({ conversationId: conversation._id, userId: req.user._id, body: req.body, file: req.file });

    const message = await conversations.createMessage(conversation, req.user._id, content.text, content, req.user);
    const dto = toMessageDto(message);
    const current = await conversations.getForUser(conversation._id, req.user._id);
    realtime.toUsers(current?.participants ?? [], 'message:new', {
      scope: 'conversation',
      conversationId: String(conversation._id),
      conversationTitle: current?.kind === 'group' ? current.title : null,
      message: dto,
    });
    res.status(201).json({ message: await presentMessage(message, req.user._id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json(apiError(err.code, err.message));
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');
    const conversation = await conversations.getForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');
    const messageId = req.body?.messageId;
    if (!mongoose.isValidObjectId(messageId)) return fail(res, 400, 'ids_invalid', 'Некорректное сообщение');
    const filter = await conversations.visibilityFilter(conversation._id, req.user._id);
    const { Message } = require('../modules/messages/message.model');
    if (!(await Message.exists({ ...filter, _id: { ...filter._id, $in: [messageId] } }))) {
      return fail(res, 404, 'message_not_found', 'Сообщение недоступно');
    }
    const state = await ConversationState.findOneAndUpdate(
      { conversation: conversation._id, user: req.user._id },
      { $max: { lastReadMessageId: new mongoose.Types.ObjectId(messageId) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payload = { conversationId: String(conversation._id), userId: String(req.user._id), messageId: String(state.lastReadMessageId) };
    realtime.toUsers(conversation.participants, 'conversation:read', payload);
    res.json(payload);
  } catch (err) { next(err); }
}

async function getConversation(req, res, next) {
  try {
    const conversation = await conversations.getDtoForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');
    res.json({ conversation });
  } catch (err) { next(err); }
}

async function pin(req, res, next) {
  try {
    if (typeof req.body?.pinned !== 'boolean') return fail(res, 400, 'invalid_data', 'Некорректное значение');
    const conversation = await conversations.getForUser(req.params.id, req.user._id);
    if (!conversation) return fail(res, 404, 'conversation_not_found', 'Диалог не найден');
    const state = await ConversationState.findOneAndUpdate({ conversation: conversation._id, user: req.user._id },
      { pinnedAt: req.body.pinned ? new Date() : null }, { upsert: true, new: true });
    const pinnedAt = state.pinnedAt ? new Date(state.pinnedAt).toISOString() : null;
    realtime.toUsers([req.user._id], 'chat:changed', { conversationId: String(conversation._id), reason: 'pin', pinnedAt });
    res.json({ conversation: { id: String(conversation._id), pinnedAt } });
  } catch (err) { next(err); }
}

module.exports = { listConversations, openConversation, listMessages, sendMessage, markRead, getConversation, pin };
