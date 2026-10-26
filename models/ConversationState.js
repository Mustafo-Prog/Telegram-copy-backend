const mongoose = require('mongoose');

// Состояние диалога для одного участника: очистка истории и скрытие чата только у него
const conversationStateSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clearedBefore: { type: Date, default: () => new Date(0) },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

conversationStateSchema.index({ conversation: 1, user: 1 }, { unique: true });

const ConversationState = mongoose.model('ConversationState', conversationStateSchema);

module.exports = { ConversationState };
