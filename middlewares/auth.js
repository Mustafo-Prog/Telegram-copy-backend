const jwt = require('jsonwebtoken');
const { User } = require('../models/User');
const { verifyToken } = require('../utils/token');
const { apiError } = require('../utils/apiError');

const UNAUTHORIZED = apiError('unauthorized', 'Требуется авторизация');

async function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json(UNAUTHORIZED);
  }

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json(UNAUTHORIZED);
    }
    req.user = user;
    next();
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {

      console.warn(`[auth] токен отклонён: ${err.name} — ${err.message}`);
      return res.status(401).json(apiError('session_expired', 'Сессия истекла, войдите снова'));
    }
    next(err);
  }
}

module.exports = { requireAuth };
