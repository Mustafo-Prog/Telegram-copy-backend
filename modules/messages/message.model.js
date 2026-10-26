const mongoose = require('mongoose');
const { MESSAGE_MAX_LENGTH } = require('./message.schema');

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
      index: true,
    },
    text: { type: String, required: true, trim: true, maxlength: MESSAGE_MAX_LENGTH },
    sentAt: { type: Date, required: true, default: () => new Date(), immutable: true },
    // null — сообщение общего чата; иначе — личный диалог
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    // Дата последнего изменения текста; null — сообщение не редактировали
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageSchema.index({ sentAt: -1 });
messageSchema.index({ conversation: 1, _id: -1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = { Message };
