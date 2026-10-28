const ACCOUNT_STATUSES = Object.freeze(['user', 'admin', 'superadmin']);

// Missing or unrecognised legacy values never grant account privileges.
const accountStatus = (value) => ACCOUNT_STATUSES.includes(value) ? value : 'user';
const isSuperadmin = (user) => accountStatus(user?.status) === 'superadmin';

function accountDetails(user, now = Date.now()) {
  const rawStatus = accountStatus(user?.status);
  const expiry = user?.premiumExpiresAt ? new Date(user.premiumExpiresAt).getTime() : NaN;
  return {
    status: rawStatus === 'admin' && !(expiry > now) ? 'user' : rawStatus,
    premiumExpiresAt: rawStatus !== 'superadmin' && Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
    premiumVersion: user?.premiumVersion ?? 0,
  };
}

module.exports = { ACCOUNT_STATUSES, accountStatus, isSuperadmin, accountDetails };
