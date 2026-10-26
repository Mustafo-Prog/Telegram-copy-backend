const mongoose = require('mongoose');

// Личный диалог: ровно два участника. directKey («id1:id2», отсортированные) уникален,
// поэтому между двумя людьми всегда один диалог.
const conversationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['direct', 'group'], default: 'direct' },
    title: { type: String, trim: true, maxlength: 80, required() { return this.kind === 'group'; } },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required() { return this.kind === 'group'; } },
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    membershipVersion: { type: Number, default: 0 },
    inviteTokenHash: { type: String, select: false },
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate(value) { return this.kind === 'group' ? value.length >= 1 && value.length <= 100 : value.length === 2; },
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
