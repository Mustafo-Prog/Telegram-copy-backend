function toMessageDto(message) {
  return {
    id: message._id.toString(),
    senderId: message.sender?._id?.toString() ?? null,
    senderName: message.sender?.displayName ?? null,
    text: message.text,
    createdAt: message.sentAt.toISOString(),
  };
}

module.exports = { toMessageDto };
