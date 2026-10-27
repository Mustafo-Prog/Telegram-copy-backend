const mongoose = require('mongoose');
const { Message } = require('../modules/messages/message.model');
const { presentMessage, toMessageDto } = require('../modules/messages/message.presenter');
const conversations = require('../services/conversationService');
const { visibleFilter } = require('../services/messageContent');
const { apiError } = require('../utils/apiError');
const realtime = require('../services/realtime');

async function open(req, res, next) {
  try {
    const conversation = await conversations.findOrCreateSaved(req.user._id);
    await conversations.unhideFor(conversation._id, req.user._id);
    res.json({ conversation: await conversations.getDtoForUser(conversation._id, req.user._id) });
  } catch (err) { next(err); }
}

async function save(req, res, next) {
  try {
    const unavailable = () => res.status(404).json(apiError('message_not_found', 'Сообщение недоступно'));
    if (!mongoose.isValidObjectId(req.params.messageId)) return unavailable();
    const source = await Message.findById(req.params.messageId);
    if (!source) return unavailable();
    if (source.conversation && !(await conversations.getForUser(source.conversation, req.user._id))) return unavailable();
    const filter = await visibleFilter(source.conversation, req.user._id);
    const original = await Message.findOne({ ...filter, _id: { ...filter._id, $in: [source._id] } })
      .select('+attachmentData').populate('sender', 'displayName');
    if (!original) return unavailable();

    const conversation = await conversations.findOrCreateSaved(req.user._id);
    const content = {
      replyTo: null,
      savedFrom: original.savedFrom ? {
        senderName: original.savedFrom.senderName,
        createdAt: original.savedFrom.createdAt,
      } : { senderName: original.sender?.displayName ?? null, createdAt: original.sentAt },
    };
    if (original.attachment) {
      // Saved files belong to the saved message and survive deletion of the source.
      content.attachment = {
        name: original.attachment.name,
        contentType: original.attachment.contentType,
        size: original.attachment.size,
        kind: original.attachment.kind ?? 'file',
        durationMs: original.attachment.durationMs ?? null,
      };
      if (!original.attachmentData) return unavailable();
      content.attachmentData = Buffer.from(original.attachmentData);
    }
    const message = await conversations.createMessage(conversation, req.user._id, original.text, content, req.user);
    realtime.toUsers([req.user._id], 'message:new', { scope: 'conversation', conversationId: String(conversation._id),
      conversationTitle: null, message: toMessageDto(message) });
    res.status(201).json({ conversation: await conversations.getDtoForUser(conversation._id, req.user._id),
      message: await presentMessage(message, req.user._id) });
  } catch (err) { next(err); }
}

module.exports = { open, save };
