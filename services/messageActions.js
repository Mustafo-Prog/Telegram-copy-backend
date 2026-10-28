const mongoose = require('mongoose');
const { Message } = require('../modules/messages/message.model');
const { Conversation } = require('../models/Conversation');
const { ConversationState } = require('../models/ConversationState');
const { MessageHide } = require('../models/MessageHide');
const { validateMessageInput } = require('../modules/messages/message.schema');

// Все операции здесь проверяют права. Контекст: conversationId === null — общий чат,
// иначе — личный диалог (проверку участника делает контроллер).
const BULK_LIMIT = 100;
const PEER_FIELDS = 'displayName username avatarUrl status premiumExpiresAt premiumVersion';

class ActionError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function assertIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ActionError(400, 'ids_invalid', 'Некорректный список сообщений');
  }
  if (ids.length > BULK_LIMIT) {
    throw new ActionError(400, 'too_many_ids', `За один раз можно выбрать не больше ${BULK_LIMIT} сообщений`);
  }
  if (!ids.every((id) => mongoose.isValidObjectId(id))) {
    throw new ActionError(400, 'ids_invalid', 'Некорректный список сообщений');
  }
  return [...new Set(ids.map(String))];
}

function assertMode(mode, allowed) {
  if (!allowed.includes(mode)) throw new ActionError(400, 'mode_not_allowed', 'Недопустимый режим удаления');
  return mode;
}

async function findMessage(conversationId, messageId) {
  if (!mongoose.isValidObjectId(messageId)) throw new ActionError(404, 'message_not_found', 'Сообщение не найдено');
  const message = await Message.findOne({ _id: messageId, conversation: conversationId ?? null });
  if (!message) throw new ActionError(404, 'message_not_found', 'Сообщение не найдено');
  return message;
}

// Последнее сообщение диалога пересчитываем после удаления/редактирования
async function refreshLastMessage(conversationId) {
  const last = await Message.findOne({ conversation: conversationId }).sort({ _id: -1 });
  await Conversation.updateOne(
    { _id: conversationId },
    { lastMessageText: last?.text || last?.attachment?.name || '', lastMessageAt: last?.sentAt ?? new Date() }
  );
}

// Окончательное удаление: из базы и из всех «скрытий»
async function hardDelete(ids, conversationId) {
  if (ids.length === 0) return;
  await Message.deleteMany({ _id: { $in: ids } });
  await MessageHide.deleteMany({ message: { $in: ids } });
  if (conversationId) await refreshLastMessage(conversationId);
}

async function editMessage({ conversationId, messageId, userId, text }) {
  const message = await findMessage(conversationId, messageId);
  if (String(message.sender) !== String(userId)) {
    throw new ActionError(403, 'forbidden', 'Редактировать можно только свои сообщения');
  }

  const error = validateMessageInput({ text: text === undefined ? null : text }, { hasAttachment: Boolean(message.attachment) });
  if (error) throw new ActionError(400, error.code, error.message);

  message.text = text.trim();
  message.editedAt = new Date();
  await message.save();
  if (conversationId) await refreshLastMessage(conversationId);
  return Message.findOne({ _id: message._id }).populate('sender', PEER_FIELDS);
}

async function deleteMessage({ conversationId, messageId, userId, mode = 'me', canDeleteOthers = true, canDeleteGeneralOthers = false }) {
  const message = await findMessage(conversationId, messageId);

  if (conversationId === null) {
    if (!canDeleteGeneralOthers && String(message.sender) !== String(userId)) {
      throw new ActionError(403, 'forbidden', 'Удалять можно только свои сообщения');
    }
    await hardDelete([message._id], null);
    return { deleted: 1, skipped: 0, deletedIds: [String(message._id)] };
  }

  if (assertMode(mode, ['me', 'everyone']) === 'me') {
    await MessageHide.findOneAndUpdate(
      { message: message._id, user: userId },
      { conversation: conversationId },
      { upsert: true }
    );
  } else {
    if (!canDeleteOthers && String(message.sender) !== String(userId)) throw new ActionError(403, 'forbidden', 'Удалять у всех можно только свои сообщения');
    await hardDelete([message._id], conversationId);
  }
  return { deleted: 1, skipped: 0, deletedIds: [String(message._id)] };
}

async function bulkDelete({ conversationId, ids, userId, mode = 'everyone', canDeleteOthers = true, canDeleteGeneralOthers = false }) {
  const list = assertIds(ids);

  if (conversationId === null) {
    if (mode !== 'everyone') throw new ActionError(400, 'mode_not_allowed', 'В общем чате удаление только для всех');
    // Account Premium does not grant moderation. Only an explicit trusted
    // superadmin decision from the controller can include other authors.
    const own = await Message.find({ _id: { $in: list }, conversation: null, ...(canDeleteGeneralOthers ? {} : { sender: userId }) });
    const ownIds = own.map((m) => m._id);
    await hardDelete(ownIds, null);
    return { deleted: ownIds.length, skipped: list.length - ownIds.length, deletedIds: ownIds.map(String) };
  }

  const filter = { _id: { $in: list }, conversation: conversationId };
  if (mode === 'everyone' && !canDeleteOthers) filter.sender = userId;
  const found = (await Message.find(filter)).map((m) => m._id);
  if (assertMode(mode, ['me', 'everyone']) === 'me') {
    for (const id of found) {
      await MessageHide.findOneAndUpdate({ message: id, user: userId }, { conversation: conversationId }, { upsert: true });
    }
  } else {
    await hardDelete(found, conversationId);
  }
  return { deleted: found.length, skipped: list.length - found.length, deletedIds: found.map(String) };
}

async function clearHistory({ conversationId, userId, mode }) {
  const now = new Date();
  if (assertMode(mode, ['me', 'both']) === 'me') {
    await ConversationState.findOneAndUpdate(
      { conversation: conversationId, user: userId },
      { clearedBefore: now },
      { upsert: true }
    );
    return;
  }

  // Для обоих: сначала фиксируем дату очистки у каждого, затем удаляем сообщения
  const conversation = await Conversation.findOne({ _id: conversationId });
  for (const participant of conversation.participants) {
    await ConversationState.findOneAndUpdate(
      { conversation: conversationId, user: participant._id ?? participant },
      { clearedBefore: now },
      { upsert: true }
    );
  }
  await Message.deleteMany({ conversation: conversationId });
  await MessageHide.deleteMany({ conversation: conversationId });
  await Conversation.updateOne({ _id: conversationId }, { lastMessageText: '' });
}

async function deleteChat({ conversationId, userId, mode }) {
  if (assertMode(mode, ['me', 'both']) === 'me') {
    await ConversationState.findOneAndUpdate(
      { conversation: conversationId, user: userId },
      { hidden: true, clearedBefore: new Date() },
      { upsert: true }
    );
    return;
  }

  // Для обоих: удаляем всё, связанное с диалогом. Повторное общение создаст новый диалог.
  await Message.deleteMany({ conversation: conversationId });
  await MessageHide.deleteMany({ conversation: conversationId });
  await ConversationState.deleteMany({ conversation: conversationId });
  await Conversation.deleteOne({ _id: conversationId });
}

module.exports = {
  ActionError,
  BULK_LIMIT,
  editMessage,
  deleteMessage,
  bulkDelete,
  clearHistory,
  deleteChat,
};
