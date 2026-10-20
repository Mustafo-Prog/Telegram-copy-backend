const mongoose = require('mongoose');
const { MESSAGE_MAX_LENGTH } = require('../schemas/messageSchemas');

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: MESSAGE_MAX_LENGTH },
  },
  { timestamps: true }
);

messageSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    senderId: this.sender?._id?.toString() ?? null,
    senderName: this.sender?.displayName ?? null,
    text: this.text,
    createdAt: this.createdAt.toISOString(),
  };
};

const Message = mongoose.model('Message', messageSchema);

module.exports = { Message };
