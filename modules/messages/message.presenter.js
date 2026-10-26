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
  };
}

module.exports = { toMessageDto };
