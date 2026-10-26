const mongoose = require('mongoose');

// Аватар хранится в MongoDB: сжатая картинка 256×256 (около 10–30 КБ), одна запись на пользователя
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
