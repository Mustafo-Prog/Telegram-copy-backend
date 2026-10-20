const bcrypt = require('bcryptjs');
const { User } = require('../models/User');
const { signToken } = require('../utils/token');
const { validateRegister, validateLogin } = require('../schemas/authSchemas');
const { apiError } = require('../utils/apiError');

const EMAIL_TAKEN = apiError('email_taken', 'Этот email уже зарегистрирован');
const INVALID_CREDENTIALS = apiError('invalid_credentials', 'Неверный email или пароль');
const BCRYPT_ROUNDS = 12;
const DISPLAY_NAME_MAX_LENGTH = 50;

const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

async function register(req, res, next) {
  try {
    const error = validateRegister(req.body);
    if (error) {
      return res.status(400).json(error);
    }

    const { password, displayName } = req.body;
    const email = req.body.email.trim().toLowerCase();

    if (await User.exists({ email })) {
      return res.status(409).json(EMAIL_TAKEN);
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const name =
      displayName?.trim() || email.split('@')[0].slice(0, DISPLAY_NAME_MAX_LENGTH);
    const user = await User.create({ email, password: hash, displayName: name });

    res.status(201).json({ token: signToken(user), user: user.toPublic() });
  } catch (err) {

    if (err.code === 11000) {
      return res.status(409).json(EMAIL_TAKEN);
    }
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const error = validateLogin(req.body);
    if (error) {
      return res.status(400).json(error);
    }

    const email = req.body.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select('+password');
    const passwordOk = await bcrypt.compare(req.body.password, user?.password ?? DUMMY_HASH);

    if (!user || !passwordOk) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    res.json({ token: signToken(user), user: user.toPublic() });
  } catch (err) {
    next(err);
  }
}

function me(req, res) {
  res.json({ user: req.user.toPublic() });
}

module.exports = { register, login, me };
