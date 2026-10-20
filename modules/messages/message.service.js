const { Message } = require('./message.model');

const HISTORY_LIMIT = 100;

async function createMessage({ senderId, text }) {
  const message = await Message.create({ sender: senderId, text });
  return message.populate('sender', 'displayName');
}

async function listRecentMessages(limit = HISTORY_LIMIT) {
  const docs = await Message.find()
    .sort({ sentAt: -1, _id: -1 })
    .limit(limit)
    .populate('sender', 'displayName');
  return docs.reverse();
}

module.exports = { createMessage, listRecentMessages };
