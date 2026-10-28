const mongoose = require('mongoose');
const { ACCOUNT_STATUSES, accountDetails } = require('../utils/accountStatus');

// Вход только по коду из письма, паролей нет.
// username уникален и необязателен (sparse), аватар — в коллекции avatars.
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'user' },
    premiumExpiresAt: { type: Date, default: null },
    premiumVersion: { type: Number, default: 0 },
    username: { type: String, trim: true, lowercase: true, maxlength: 32, index: { unique: true, sparse: true } },
    bio: { type: String, default: '', trim: true, maxlength: 150 },
    avatarUrl: { type: String, default: null },
    lastSeenAt: { type: Date, default: null },
    generalPinnedAt: { type: Date, default: null },
    privacy: {
      showOnlineStatus: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

// Себе — вся информация, включая email
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    generalPinnedAt: this.generalPinnedAt ? new Date(this.generalPinnedAt).toISOString() : null,
    displayName: this.displayName,
    ...accountDetails(this),
    username: this.username ?? null,
    bio: this.bio ?? '',
    avatarUrl: this.avatarUrl ?? null,
    privacy: { showOnlineStatus: this.privacy?.showOnlineStatus !== false },
  };
};

// Другим людям — без email
userSchema.methods.toPublicProfile = function toPublicProfile() {
  return {
    id: this._id.toString(),
    displayName: this.displayName,
    ...accountDetails(this),
    username: this.username ?? null,
    bio: this.bio ?? '',
    avatarUrl: this.avatarUrl ?? null,
  };
};

userSchema.index({ status: 1, premiumExpiresAt: 1 });
const User = mongoose.model('User', userSchema);

module.exports = { User };
