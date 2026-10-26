const mongoose = require('mongoose');
const { GeneralReadState } = require('../models/GeneralReadState');

async function markRead(userId, messageId) {
  const filter = { user: userId };
  const update = { $max: { lastReadMessageId: new mongoose.Types.ObjectId(messageId) } };
  try {
    return await GeneralReadState.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (err) {
    // Two tabs may create this reader's first cursor simultaneously.
    if (err.code === 11000) return GeneralReadState.findOneAndUpdate(filter, update, { new: true });
    throw err;
  }
}

async function latestReaders() {
  // Only the author must be excluded: the two furthest distinct readers are sufficient.
  return GeneralReadState.find({}).sort({ lastReadMessageId: -1 }).limit(2).select('user lastReadMessageId');
}

function wasReadByOther(message, readers) {
  const senderId = String(message.sender?._id ?? message.sender);
  return readers.some((reader) => String(reader.user) !== senderId && String(reader.lastReadMessageId) >= String(message._id));
}

module.exports = { markRead, latestReaders, wasReadByOther };
