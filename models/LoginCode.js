const mongoose = require('mongoose');

// Одна запись на email: хеш текущего кода, число попыток и история отправок.
// Документ удаляется через час после последней отправки (TTL по expiresAt).
const loginCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, default: null },
    codeExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    sentAt: { type: [Date], default: [] },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

const LoginCode = mongoose.model('LoginCode', loginCodeSchema);

module.exports = { LoginCode };
