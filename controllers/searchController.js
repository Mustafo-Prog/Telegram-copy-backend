const mongoose = require('mongoose');
const { Message } = require('../modules/messages/message.model');
const conversations = require('../services/conversationService');
const { presentMessages } = require('../modules/messages/message.presenter');
const { apiError } = require('../utils/apiError');
const PAGE_SIZE = 30;

async function search(req, res, next) {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2 || q.length > 100) return res.status(400).json(apiError('search_invalid', 'Поиск: от 2 до 100 символов'));
    let filter = { conversation: null };
    if (req.params.id) {
      const conversation = await conversations.getForUser(req.params.id, req.user._id);
      if (!conversation) return res.status(404).json(apiError('conversation_not_found', 'Диалог не найден'));
      filter = await conversations.visibilityFilter(conversation._id, req.user._id);
    }
    const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(literal, 'i');
    filter.$or = [{ text: { $regex: regex } }, { 'attachment.name': { $regex: regex } }];
    if (mongoose.isValidObjectId(req.query.before)) filter._id = { ...filter._id, $lt: req.query.before };
    const docs = await Message.find(filter).sort({ _id: -1 }).limit(PAGE_SIZE).populate('sender', 'displayName username avatarUrl status premiumExpiresAt premiumVersion');
    res.json({ messages: await presentMessages(docs, req.user._id), hasMore: docs.length === PAGE_SIZE });
  } catch (err) { next(err); }
}
module.exports = { search };
