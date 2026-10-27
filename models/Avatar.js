const mongoose = require('mongoose');

// Аватар хранится в MongoDB: сжатая картинка до 1024×1024 и 300 КиБ, одна запись на пользователя.
const avatarSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    contentType: { type: String, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

const Avatar = mongoose.model('Avatar', avatarSchema);

module.exports = { Avatar };
