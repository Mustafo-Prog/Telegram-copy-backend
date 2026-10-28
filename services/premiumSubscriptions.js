const { User } = require('../models/User');
const { accountDetails, isSuperadmin } = require('../utils/accountStatus');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function publishAccount(user) {
  const realtime = require('./realtime');
  const payload = { userId: String(user._id), ...accountDetails(user) };
  realtime.toUsers([user._id], 'account:updated', payload);
  realtime.toGeneral('user:updated', payload);
}

// The null filter matches legacy missing fields too; a restart cannot extend an assigned term.
async function migrateLegacyPremium(now = Date.now()) {
  return User.updateMany({ status: 'admin', premiumExpiresAt: null }, {
    $set: { premiumExpiresAt: new Date(now + DEFAULT_DAYS * DAY_MS) }, $inc: { premiumVersion: 1 },
  });
}

async function grantPremium(userId, { durationDays = DEFAULT_DAYS, renew = false, expectedExpiresAt, expectedVersion } = {}, now = Date.now()) {
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_DAYS || typeof renew !== 'boolean') {
    throw fail(400, 'premium_duration_invalid', 'Срок Premium: от 1 до 365 дней');
  }
  const target = await User.findById(userId);
  if (!target) throw fail(404, 'user_not_found', 'Пользователь не найден');
  if (isSuperadmin(target) || !['user', 'admin', null, undefined].includes(target.status)) {
    throw fail(403, 'status_protected', 'Нельзя изменить этот статус');
  }
  const current = accountDetails(target, now);
  if (current.status === 'admin' && !renew) return target; // Retries of the initial grant are idempotent.
  if (renew && (current.status !== 'admin' || expectedExpiresAt !== current.premiumExpiresAt || expectedVersion !== current.premiumVersion)) {
    throw fail(409, 'premium_changed', 'Подписка изменилась, обновите профиль');
  }
  const filter = { _id: target._id, status: target.status ?? null, premiumExpiresAt: target.premiumExpiresAt ?? null };
  if (current.premiumVersion === 0) filter.$or = [{ premiumVersion: 0 }, { premiumVersion: null }];
  else filter.premiumVersion = current.premiumVersion;
  const base = current.status === 'admin' ? new Date(current.premiumExpiresAt).getTime() : now;
  const updated = await User.findOneAndUpdate(filter, {
    $set: { status: 'admin', premiumExpiresAt: new Date(base + durationDays * DAY_MS) }, $inc: { premiumVersion: 1 },
  }, { new: true, runValidators: true });
  if (!updated) {
    const latest = await User.findById(userId);
    if (!renew && accountDetails(latest, now).status === 'admin') return latest;
    throw fail(409, 'premium_changed', 'Подписка изменилась, обновите профиль');
  }
  publishAccount(updated);
  return updated;
}

async function expirePremium(now = Date.now()) {
  const due = await User.find({ status: 'admin', premiumExpiresAt: { $ne: null, $lte: new Date(now) } }).limit(200);
  let expired = 0;
  for (const user of due) {
    // A concurrent renewal moves the expiry forward and prevents this update from matching.
    const updated = await User.findOneAndUpdate({ _id: user._id, status: 'admin', premiumExpiresAt: { $ne: null, $lte: new Date(now) } }, {
      $set: { status: 'user' }, $inc: { premiumVersion: 1 },
    }, { new: true });
    if (updated) { expired++; publishAccount(updated); }
  }
  return expired;
}

async function startPremiumMaintenance() {
  await migrateLegacyPremium();
  await expirePremium();
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await migrateLegacyPremium(); await expirePremium(); }
    catch (err) { console.error('Premium maintenance:', err.message); }
    finally { running = false; }
  }, 60000);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { DAY_MS, DEFAULT_DAYS, MAX_DAYS, grantPremium, migrateLegacyPremium, expirePremium, startPremiumMaintenance };
