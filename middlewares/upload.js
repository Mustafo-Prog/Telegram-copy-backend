const multer = require('multer');

const MAX_AVATAR_BYTES = 300 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Файл держим в памяти и сохраняем в MongoDB, на диск сервера ничего не пишем
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      const err = new Error('Unsupported avatar type');
      err.apiCode = 'avatar_invalid';
      return callback(err);
    }
    callback(null, true);
  },
});

module.exports = { uploadAvatar: upload.single('avatar') };
