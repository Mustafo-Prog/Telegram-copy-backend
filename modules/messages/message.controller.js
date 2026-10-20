const { validateMessageInput } = require('./message.schema');
const messageService = require('./message.service');
const { toMessageDto } = require('./message.presenter');

async function list(_req, res, next) {
  try {
    const docs = await messageService.listRecentMessages();
    res.json({ messages: docs.map(toMessageDto) });
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
    res.status(201).json({ message: toMessageDto(message) });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create };
