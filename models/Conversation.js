const mongoose = require('mongoose');

// Личный диалог: ровно два участника. directKey («id1:id2», отсортированные) уникален,
// поэтому между двумя людьми всегда один диалог.
const conversationSchema = new mongoose.Schema(
  {
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: (value) => value.length === 2,
    },
    directKey: { type: String, required: true, unique: true },
    lastMessageAt: { type: Date, default: () => new Date() },
    lastMessageText: { type: String, default: '' },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = { Conversation };
