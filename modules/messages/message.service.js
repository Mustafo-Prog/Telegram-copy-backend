const { Message } = require('./message.model');

const PAGE_SIZE = 50;

async function createMessage({ senderId, sender, text, ...content }) {
  const message = await Message.create({ sender: senderId, text, ...content });
  if (sender) { message.sender = sender; return message; }
  return message.populate('sender', 'displayName username avatarUrl status');
}

// Страница общего чата: последние PAGE_SIZE до курсора before (id самого старого уже загруженного)
async function listRecentMessages({ before, limit = PAGE_SIZE } = {}) {
  const filter = { conversation: null };
  if (before) filter._id = { $lt: before };
  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit)
    .populate('sender', 'displayName username avatarUrl status');
  return docs.reverse();
}

module.exports = { createMessage, listRecentMessages, PAGE_SIZE };
