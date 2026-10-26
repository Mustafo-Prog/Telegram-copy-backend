const mongoose = require('mongoose');

// A cursor per reader avoids storing an unbounded list of viewers on every message.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  lastReadMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
}, { timestamps: true });

schema.index({ lastReadMessageId: -1 });

module.exports = { GeneralReadState: mongoose.model('GeneralReadState', schema) };
