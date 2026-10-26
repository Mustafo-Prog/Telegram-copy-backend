const mongoose = require('mongoose');

// «Удалить только у меня»: сообщение скрыто для одного пользователя, у второго остаётся
const messageHideSchema = new mongoose.Schema(
  {
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

messageHideSchema.index({ message: 1, user: 1 }, { unique: true });
messageHideSchema.index({ conversation: 1, user: 1 });

const MessageHide = mongoose.model('MessageHide', messageHideSchema);

module.exports = { MessageHide };
