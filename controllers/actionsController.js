const mongoose = require('mongoose');
const actions = require('../services/messageActions');
const conversations = require('../services/conversationService');
const { toMessageDto } = require('../modules/messages/message.presenter');
const { apiError } = require('../utils/apiError');
const realtime = require('../services/realtime');

function fail(res, err, next) {
  if (err instanceof actions.ActionError) {
    return res.status(err.status).json(apiError(err.code, err.message));
  }
  return next(err);
}

// Для личных диалогов сначала проверяем, что пользователь — участник
async function withConversation(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json(apiError('conversation_not_found', 'Диалог не найден'));
    return null;
  }
  const conversation = await conversations.getForUser(req.params.id, req.user._id);
  if (!conversation) {
    res.status(404).json(apiError('conversation_not_found', 'Диалог не найден'));
    return null;
  }
  return conversation;
}

// Кому сообщать: «у меня» — только мне, «у всех» / «для обоих» — всем участникам
const audience = (conversation, userId, forEveryone) => (forEveryone ? conversation.participants : [userId]);

// --- общий чат (/api/messages)
async function editGeneral(req, res, next) {
  try {
    const message = await actions.editMessage({
      conversationId: null,
      messageId: req.params.id,
      userId: req.user._id,
      text: req.body?.text,
    });
    const dto = toMessageDto(message);
    realtime.toGeneral('message:updated', { scope: 'general', message: dto });
    res.json({ message: dto });
  } catch (err) {
    fail(res, err, next);
  }
}

async function deleteGeneral(req, res, next) {
  try {
    const result = await actions.deleteMessage({ conversationId: null, messageId: req.params.id, userId: req.user._id });
    if (result.deletedIds.length) realtime.toGeneral('message:deleted', { scope: 'general', ids: result.deletedIds });
    res.json(result);
  } catch (err) {
    fail(res, err, next);
  }
}

async function bulkDeleteGeneral(req, res, next) {
  try {
    const result = await actions.bulkDelete({ conversationId: null, ids: req.body?.ids, userId: req.user._id, mode: req.body?.mode ?? 'everyone' });
    if (result.deletedIds.length) realtime.toGeneral('message:deleted', { scope: 'general', ids: result.deletedIds });
    res.json(result);
  } catch (err) {
    fail(res, err, next);
  }
}

// --- личные диалоги (/api/conversations/:id/...)
async function editInConversation(req, res, next) {
  try {
    const conversation = await withConversation(req, res);
    if (!conversation) return;
    const message = await actions.editMessage({
      conversationId: conversation._id,
      messageId: req.params.messageId,
      userId: req.user._id,
      text: req.body?.text,
    });
    const dto = toMessageDto(message);
    realtime.toUsers(conversation.participants, 'message:updated', {
      scope: 'conversation',
      conversationId: String(conversation._id),
      message: dto,
    });
    res.json({ message: dto });
  } catch (err) {
    fail(res, err, next);
  }
}

async function deleteInConversation(req, res, next) {
  try {
    const conversation = await withConversation(req, res);
    if (!conversation) return;
    const mode = req.query.mode ?? 'me';
    const result = await actions.deleteMessage({
      conversationId: conversation._id,
      messageId: req.params.messageId,
      userId: req.user._id,
      mode,
    });
    if (result.deletedIds.length) {
      realtime.toUsers(audience(conversation, req.user._id, mode === 'everyone'), 'message:deleted', {
        scope: 'conversation',
        conversationId: String(conversation._id),
        ids: result.deletedIds,
      });
    }
    res.json(result);
  } catch (err) {
    fail(res, err, next);
  }
}

async function bulkDeleteInConversation(req, res, next) {
  try {
    const conversation = await withConversation(req, res);
    if (!conversation) return;
    const mode = req.body?.mode ?? 'me';
    const result = await actions.bulkDelete({
      conversationId: conversation._id,
      ids: req.body?.ids,
      userId: req.user._id,
      mode,
    });
    if (result.deletedIds.length) {
      realtime.toUsers(audience(conversation, req.user._id, mode === 'everyone'), 'message:deleted', {
        scope: 'conversation',
        conversationId: String(conversation._id),
        ids: result.deletedIds,
      });
    }
    res.json(result);
  } catch (err) {
    fail(res, err, next);
  }
}

async function clearInConversation(req, res, next) {
  try {
    const conversation = await withConversation(req, res);
    if (!conversation) return;
    const mode = req.body?.mode ?? 'me';
    await actions.clearHistory({ conversationId: conversation._id, userId: req.user._id, mode });
    realtime.toUsers(audience(conversation, req.user._id, mode === 'both'), 'chat:changed', {
      conversationId: String(conversation._id),
      reason: 'cleared',
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, next);
  }
}

async function deleteConversation(req, res, next) {
  try {
    const conversation = await withConversation(req, res);
    if (!conversation) return;
    const mode = req.body?.mode ?? req.query.mode ?? 'me';
    await actions.deleteChat({ conversationId: conversation._id, userId: req.user._id, mode });
    realtime.toUsers(audience(conversation, req.user._id, mode === 'both'), 'chat:changed', {
      conversationId: String(conversation._id),
      reason: 'deleted',
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, next);
  }
}

module.exports = {
  editGeneral,
  deleteGeneral,
  bulkDeleteGeneral,
  editInConversation,
  deleteInConversation,
  bulkDeleteInConversation,
  clearInConversation,
  deleteConversation,
};
