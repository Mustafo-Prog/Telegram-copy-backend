const mongoose = require('mongoose');
const { User } = require('../models/User');
const avatarStorage = require('../services/avatarStorage');
const { validateProfile, normalizeUsername, escapeRegex, USERNAME_RE } = require('../schemas/profileSchemas');
const { apiError } = require('../utils/apiError');
const presence = require('../services/presence');

const MESSAGES = {
  privacy_invalid: 'Некорректное значение настройки',
  username_taken: 'Этот ник уже занят',
  displayname_invalid: 'Имя: от 1 до 50 символов',
  username_invalid: 'Ник: 3–32 символа, латиница, цифры и _',
  bio_too_long: 'Описание не длиннее 150 символов',
  nothing_to_update: 'Нечего сохранять',
  avatar_required: 'Выберите файл',
  avatar_upload_failed: 'Не удалось загрузить аватар, попробуйте позже',
  user_not_found: 'Пользователь не найден',
};

function sendError(res, status, code) {
  return res.status(status).json(apiError(code, MESSAGES[code] ?? code));
}

const SEARCH_LIMIT = 20;
const SEARCH_MIN_LENGTH = 2;

async function updateMe(req, res, next) {
  try {
    const { values, error } = validateProfile(req.body);
    if (error) return sendError(res, 400, error);

    const user = await User.findById(req.user._id);

    if (values.username && values.username !== user.username) {
      const taken = await User.exists({ username: values.username, _id: { $ne: user._id } });
      if (taken) return sendError(res, 409, 'username_taken');
      user.username = values.username;
    }
    if (values.displayName !== undefined) user.displayName = values.displayName;
    if (values.bio !== undefined) user.bio = values.bio;

    await user.save();
    res.json({ user: user.toPublic() });
  } catch (err) {
    // Два одновременных сохранения одного ника ловит уникальный индекс
    if (err.code === 11000) return sendError(res, 409, 'username_taken');
    next(err);
  }
}

async function uploadMyAvatar(req, res, next) {
  try {
    if (!req.file) return sendError(res, 400, 'avatar_required');

    const user = await User.findById(req.user._id);
    user.avatarUrl = await avatarStorage.saveAvatar(user._id, req.file.buffer);
    await user.save();
    res.json({ user: user.toPublic() });
  } catch (err) {
    next(err);
  }
}

async function removeMyAvatar(req, res, next) {
  try {
    const user = await User.findById(req.user._id);
    await avatarStorage.deleteAvatar(user._id);
    user.avatarUrl = null;
    await user.save();
    res.json({ user: user.toPublic() });
  } catch (err) {
    next(err);
  }
}

// Публичная отдача картинки: без авторизации, потому что <img> не умеет слать заголовок Authorization
async function getAvatar(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, 'user_not_found');
    const avatar = await avatarStorage.findAvatar(req.params.id);
    if (!avatar) return sendError(res, 404, 'user_not_found');

    res.set('Content-Type', avatar.contentType);
    // Ссылка содержит ?v=время, поэтому кэшировать можно надолго
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(avatar.data);
  } catch (err) {
    next(err);
  }
}

async function searchUsers(req, res, next) {
  try {
    const query = normalizeUsername(req.query.q);
    if (query.length < SEARCH_MIN_LENGTH) return res.json({ users: [] });

    const users = await User.find({
      username: { $regex: `^${escapeRegex(query)}` },
      _id: { $ne: req.user._id },
    })
      .select('displayName username bio avatarUrl privacy lastSeenAt')
      .limit(SEARCH_LIMIT);

    res.json({ users: users.map((u) => ({ ...u.toPublicProfile(), presence: presence.visibleStatus(u), lastSeenAt: presence.visiblePresence(u).lastSeenAt })) });
  } catch (err) {
    next(err);
  }
}

async function getProfile(req, res, next) {
  try {
    const username = normalizeUsername(req.params.username);
    if (!USERNAME_RE.test(username)) return sendError(res, 404, 'user_not_found');

    const user = await User.findOne({ username });
    if (!user) return sendError(res, 404, 'user_not_found');
    res.json({ user: { ...user.toPublicProfile(), presence: presence.visibleStatus(user), lastSeenAt: presence.visiblePresence(user).lastSeenAt } });
  } catch (err) {
    next(err);
  }
}

// Настройка «Показывать мой онлайн». Применяется на сервере: скрытый статус не уходит ни в API, ни в сокеты
async function updatePrivacy(req, res, next) {
  try {
    const value = req.body?.showOnlineStatus;
    if (typeof value !== 'boolean') return sendError(res, 400, 'privacy_invalid');
    const user = await User.findById(req.user._id);
    user.privacy = { ...(user.privacy ?? {}), showOnlineStatus: value };
    await user.save();
    await presence.privacyChanged(user._id);
    if (value === false) require('../services/typing').stopUser(user._id);
    res.json({ user: user.toPublic() });
  } catch (err) {
    next(err);
  }
}

async function pinGeneral(req, res, next) {
  try {
    if (typeof req.body?.pinned !== 'boolean') return sendError(res, 400, 'invalid_data');
    await User.updateOne({ _id: req.user._id }, { generalPinnedAt: req.body.pinned ? new Date() : null });
    const user = await User.findById(req.user._id);
    require('../services/realtime').toUsers([user._id], 'preferences:changed', { generalPinnedAt: user.generalPinnedAt ? new Date(user.generalPinnedAt).toISOString() : null });
    res.json({ user: user.toPublic() });
  } catch (err) { next(err); }
}

module.exports = { updateMe, uploadMyAvatar, removeMyAvatar, getAvatar, searchUsers, getProfile, updatePrivacy, pinGeneral };
