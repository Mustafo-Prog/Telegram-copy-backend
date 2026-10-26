function toMessageDto(message) {
  return {
    id: message._id.toString(),
    senderId: message.sender?._id?.toString() ?? null,
    senderName: message.sender?.displayName ?? null,
    senderUsername: message.sender?.username ?? null,
    senderAvatarUrl: message.sender?.avatarUrl ?? null,
    conversationId: message.conversation?.toString() ?? null,
    text: message.text,
    createdAt: message.sentAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    replyTo: message.replyTo ? { id: String(message.replyTo) } : null,
    attachment: message.attachment ? {
      name: message.attachment.name,
      contentType: message.attachment.contentType,
      size: message.attachment.size,
      url: `/messages/${message._id}/attachment`,
    } : null,
  };
}

// Quotes are resolved for the viewer, so hidden or cleared text cannot leak through a reply.
async function presentMessages(messages, userId) {
  if (!messages.length) return [];
  const ids = [...new Set(messages.filter((m) => m.replyTo).map((m) => String(m.replyTo)))];
  let originals = [];
  if (ids.length) {
    const { Message } = require('./message.model');
    const { visibleFilter } = require('../../services/messageContent');
    const filter = await visibleFilter(messages[0].conversation, userId);
    originals = await Message.find({ ...filter, _id: { ...filter._id, $in: ids } }).populate('sender', 'displayName');
  }
  const byId = new Map(originals.map((m) => [String(m._id), m]));
  return messages.map((m) => {
    const dto = toMessageDto(m);
    if (dto.replyTo) {
      const original = byId.get(dto.replyTo.id);
      dto.replyTo = original ? {
        id: dto.replyTo.id,
        senderName: original.sender?.displayName ?? null,
        text: original.text,
        attachmentName: original.attachment?.name ?? null,
      } : { id: dto.replyTo.id, unavailable: true };
    }
    return dto;
  });
}

async function presentMessage(message, userId) { return (await presentMessages([message], userId))[0]; }

module.exports = { toMessageDto, presentMessages, presentMessage };
