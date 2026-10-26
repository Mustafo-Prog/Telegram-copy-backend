const { Avatar } = require('../models/Avatar');

const MAX_AVATAR_BYTES = 300 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Определяем тип по содержимому, а не по заголовку от клиента
function detectImageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function avatarPath(userId, version) {
  return `/api/users/${userId}/avatar?v=${version}`;
}

async function saveAvatar(userId, buffer) {
  const contentType = detectImageType(buffer);
  if (!contentType) {
    const err = new Error('Unsupported avatar content');
    err.apiCode = 'avatar_invalid';
    throw err;
  }
  await Avatar.findOneAndUpdate(
    { owner: userId },
    { owner: userId, contentType, data: buffer },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return avatarPath(userId, Date.now());
}

async function deleteAvatar(userId) {
  await Avatar.deleteOne({ owner: userId });
}

async function findAvatar(userId) {
  return Avatar.findOne({ owner: userId });
}

module.exports = { saveAvatar, deleteAvatar, findAvatar, detectImageType, avatarPath, MAX_AVATAR_BYTES };
