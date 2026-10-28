const mongoose = require('mongoose');
const { Message } = require('../modules/messages/message.model');
const { ConversationState } = require('../models/ConversationState');
const { GeneralReadState } = require('../models/GeneralReadState');
const conversations = require('../services/conversationService');
const { REACTION_EMOJIS, reactionSummary } = require('../services/reactions');
const { accountStatus } = require('../utils/accountStatus');
const { apiError } = require('../utils/apiError');
const realtime = require('../services/realtime');

const unavailable = () => Object.assign(new Error('Сообщение недоступно'), { status: 404, code: 'message_not_found' });

async function accessibleMessage(messageId, userId) {
  if (!mongoose.isValidObjectId(messageId)) throw unavailable();
  const message = await Message.findById(messageId);
  if (!message) throw unavailable();
  let conversation = null;
  if (message.conversation) {
    conversation = await conversations.getForUser(message.conversation, userId);
    if (!conversation) throw unavailable();
    const filter = await conversations.visibilityFilter(conversation._id, userId);
    if (!(await Message.exists({ ...filter, _id: { ...filter._id, $in: [message._id] } }))) throw unavailable();
  }
  return { message, conversation };
}

function handleError(err, res, next) {
  if (err.status) return res.status(err.status).json(apiError(err.code, err.message));
  next(err);
}

async function setReaction(req, res, next) {
  try {
    const { message, conversation } = await accessibleMessage(req.params.id, req.user._id);
    const { emoji, active } = req.body ?? {};
    if (!REACTION_EMOJIS.includes(emoji) || typeof active !== 'boolean') {
      return res.status(400).json(apiError('reaction_invalid', 'Некорректная реакция'));
    }
    const entry = { user: req.user._id, emoji };
    // An explicit desired state makes retries safe. Both the array and version change atomically.
    const updated = await Message.findOneAndUpdate({ _id: message._id, conversation: message.conversation ?? null }, {
      [active ? '$addToSet' : '$pull']: { reactions: entry }, $inc: { reactionsVersion: 1 },
    }, { new: true, runValidators: true });
    if (!updated) throw unavailable();
    const payload = { scope: conversation ? 'conversation' : 'general',
      conversationId: conversation ? String(conversation._id) : null,
      messageId: String(updated._id), reactions: reactionSummary(updated.reactions), reactionsVersion: updated.reactionsVersion };
    if (conversation) {
      const current = await conversations.getForUser(conversation._id, req.user._id);
      realtime.toUsers(current?.participants ?? [], 'message:reactions', payload);
    } else realtime.toGeneral('message:reactions', payload);
    res.json(payload);
  } catch (err) { handleError(err, res, next); }
}

async function readers(req, res, next) {
  try {
    const { message, conversation } = await accessibleMessage(req.params.id, req.user._id);
    if (String(message.sender?._id ?? message.sender) !== String(req.user._id) || (conversation && conversation.kind !== 'group')) {
      return res.status(403).json(apiError('readers_forbidden', 'Просмотры доступны автору сообщения в группе'));
    }
    const filter = { lastReadMessageId: { $gte: message._id }, user: { $ne: req.user._id } };
    if (conversation) {
      filter.conversation = conversation._id;
      filter.user.$in = conversation.participants;
    }
    const states = await (conversation ? ConversationState : GeneralReadState).find(filter)
      .populate('user', 'displayName username avatarUrl status');
    const users = states.filter((state) => state.user?.displayName).map(({ user }) => ({
      id: String(user._id), displayName: user.displayName, username: user.username ?? null,
      avatarUrl: user.avatarUrl ?? null, status: accountStatus(user.status),
    }));
    users.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ messageId: String(message._id), readers: users });
  } catch (err) { handleError(err, res, next); }
}

module.exports = { setReaction, readers };
