const mongoose = require('mongoose');
const realtime = require('../../services/realtime');
const { validateMessageInput } = require('./message.schema');
const messageService = require('./message.service');
const { toMessageDto } = require('./message.presenter');

async function list(req, res, next) {
  try {
    const before = mongoose.isValidObjectId(req.query.before) ? String(req.query.before) : undefined;
    const docs = await messageService.listRecentMessages({ before });
    res.json({
      messages: docs.map(toMessageDto),
      hasMore: docs.length === messageService.PAGE_SIZE,
    });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const error = validateMessageInput(req.body);
    if (error) {
      return res.status(400).json(error);
    }

    const message = await messageService.createMessage({
      senderId: req.user._id,
      text: req.body.text.trim(),
    });
    const dto = toMessageDto(message);
    realtime.toGeneral('message:new', { scope: 'general', message: dto });
    res.status(201).json({ message: dto });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create };
