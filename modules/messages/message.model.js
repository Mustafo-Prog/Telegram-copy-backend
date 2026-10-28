const mongoose = require('mongoose');
const { MESSAGE_MAX_LENGTH } = require('./message.schema');
const { REACTION_EMOJIS } = require('../../services/reactions');

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
      index: true,
    },
    text: { type: String, default: '', required() { return !this.attachment; }, trim: true, maxlength: MESSAGE_MAX_LENGTH },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    clientMessageId: { type: String, minlength: 1, maxlength: 80, default: null },
    reactions: { type: [new mongoose.Schema({
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      emoji: { type: String, enum: REACTION_EMOJIS, required: true },
    }, { _id: false })], default: [] },
    reactionsVersion: { type: Number, default: 0 },
    savedFrom: {
      type: new mongoose.Schema({ senderName: String, createdAt: Date }, { _id: false }),
      default: null,
    },
    attachment: {
      type: new mongoose.Schema({ name: String, contentType: String, size: Number,
        kind: { type: String, enum: ['file', 'voice'], default: 'file' }, durationMs: { type: Number, default: null } }, { _id: false }),
      default: null,
    },
    // Binary content is excluded from ordinary queries, DTOs and socket events.
    attachmentData: { type: Buffer, select: false },
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
