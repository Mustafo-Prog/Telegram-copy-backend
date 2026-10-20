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
  },
  { timestamps: true }
);

messageSchema.index({ sentAt: -1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = { Message };
