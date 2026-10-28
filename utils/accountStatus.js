const ACCOUNT_STATUSES = Object.freeze(['user', 'admin', 'superadmin']);

// Missing or unrecognised legacy values never grant account privileges.
const accountStatus = (value) => ACCOUNT_STATUSES.includes(value) ? value : 'user';
const isSuperadmin = (user) => accountStatus(user?.status) === 'superadmin';

module.exports = { ACCOUNT_STATUSES, accountStatus, isSuperadmin };
