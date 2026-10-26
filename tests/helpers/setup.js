// Общие настройки для тестов: переменные окружения и подмена базы данных
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.MONGODB_URI = 'mongodb://emulated';
process.env.MAIL_MODE = 'console';
process.env.PORT = '0';

const mongoose = require('mongoose');
mongoose.connect = async () => {};

const memdb = require('./memdb');
const models = ['../../models/User', '../../models/Conversation', '../../modules/messages/message.model',
  '../../models/ConversationState', '../../models/MessageHide', '../../models/Avatar', '../../models/LoginCode'];
for (const m of models) memdb.install(require(path.join(__dirname, m)).__model ?? Object.values(require(path.join(__dirname, m)))[0]);

module.exports = { memdb };
