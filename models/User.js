const mongoose = require('mongoose');

// Вход только по коду из письма, паролей нет
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
  },
  { timestamps: true }
);

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    displayName: this.displayName,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = { User };
