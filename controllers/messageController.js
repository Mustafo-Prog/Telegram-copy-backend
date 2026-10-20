const { Message } = require('../models/Message');
const { validateMessage } = require('../schemas/messageSchemas');

const HISTORY_LIMIT = 100;

async function listMessages(_req, res, next) {
  try {
    const docs = await Message.find()
      .sort({ _id: -1 })
      .limit(HISTORY_LIMIT)
      .populate('sender', 'displayName');

    res.json({ messages: docs.reverse().map((doc) => doc.toPublic()) });
  } catch (err) {
    next(err);
  }
}

async function createMessage(req, res, next) {
  try {
    const error = validateMessage(req.body);
    if (error) {
      return res.status(400).json(error);
    }

    const message = await Message.create({ sender: req.user._id, text: req.body.text.trim() });
    await message.populate('sender', 'displayName');

    res.status(201).json({ message: message.toPublic() });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMessages, createMessage };
