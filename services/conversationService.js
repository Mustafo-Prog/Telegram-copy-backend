const { Conversation } = require('../models/Conversation');
const { Message } = require('../modules/messages/message.model');
const { ConversationState } = require('../models/ConversationState');
const { MessageHide } = require('../models/MessageHide');
const mongoose = require('mongoose');
const { accountStatus } = require('../utils/accountStatus');

const EPOCH = new Date(0);

// Фильтр видимости: сообщения после очистки истории и без тех, что скрыты именно этому пользователю
async function visibilityFilter(conversationId, userId, before) {
  const state = await ConversationState.findOne({ conversation: conversationId, user: userId });
  const hiddenIds = await MessageHide.distinct('message', { conversation: conversationId, user: userId });
  const idCondition = { $nin: hiddenIds };
  if (before) idCondition.$lt = before;
  return { conversation: conversationId, sentAt: { $gt: state?.clearedBefore ?? EPOCH }, _id: idCondition };
}

// Открыть диалог — значит показать его снова тому, кто его скрыл
async function unhideFor(conversationId, userId) {
  await ConversationState.findOneAndUpdate({ conversation: conversationId, user: userId }, { hidden: false }, { upsert: true });
}

const PAGE_SIZE = 50;
const PEER_FIELDS = 'displayName username avatarUrl privacy lastSeenAt status';
const presence = require('./presence');

function directKeyFor(a, b) {
  return [String(a), String(b)].sort().join(':');
}

function openDirectOnce(userId, peerId) {
  return Conversation.findOneAndUpdate(
    { directKey: directKeyFor(userId, peerId) },
    {
      $setOnInsert: {
        participants: [userId, peerId],
        directKey: directKeyFor(userId, peerId),
        lastMessageAt: new Date(),
        lastMessageText: '',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Два одновременных «написать» могут столкнуться на уникальном directKey — повторяем один раз
async function findOrCreateDirect(userId, peerId) {
  try {
    return await openDirectOnce(userId, peerId);
  } catch (err) {
    if (err.code === 11000) return openDirectOnce(userId, peerId);
    throw err;
  }
}

async function findOrCreateSaved(userId) {
  const open = () => Conversation.findOneAndUpdate({ directKey: `saved:${userId}` }, {
    $setOnInsert: { kind: 'saved', participants: [userId], directKey: `saved:${userId}`, lastMessageText: '' },
  }, { upsert: true, new: true, setDefaultsOnInsert: true });
  try { return await open(); }
  catch (err) { if (err.code === 11000) return open(); throw err; }
}

// Последнее сообщение, которое видит именно этот пользователь (учитывает «удалить у меня» и очистку)
async function previewFor(conversationId, userId) {
  const filter = await visibilityFilter(conversationId, userId);
  const last = await Message.findOne(filter).sort({ _id: -1 });
  return last ? { id: String(last._id), text: last.text || last.attachment?.name || '', at: last.sentAt, type: last.text ? 'text' : last.attachment?.kind ?? 'file' } : { text: '', at: null };
}

// Ошибка для контроллера: статус и код API
class ChatGoneError extends Error {
  constructor() {
    super('Диалог не найден');
    this.status = 404;
    this.code = 'conversation_not_found';
  }
}

async function listForUser(userId) {
  const [hiddenValues, pinnedValues] = await Promise.all([
    ConversationState.distinct('conversation', { user: userId, hidden: true }),
    ConversationState.distinct('conversation', { user: userId, pinnedAt: { $ne: null } }),
  ]);
  // MongoDB returns ObjectIds from distinct; compare their values, not object identity.
  const hiddenIds = hiddenValues.map(String);
  const hidden = new Set(hiddenIds);
  const recent = await Conversation.find({ participants: userId, _id: { $nin: hiddenIds } })
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .populate('participants', PEER_FIELDS);
  const recentIds = new Set(recent.map((conversation) => String(conversation._id)));
  const missing = [...new Set(pinnedValues.map(String))].filter((id) => !hidden.has(id) && !recentIds.has(id));
  const pinned = missing.length ? await Conversation.find({ participants: userId, _id: { $in: missing } }).populate('participants', PEER_FIELDS) : [];
  const included = new Set();
  return [...pinned, ...recent].filter((conversation) => {
    const id = String(conversation._id);
    if (hidden.has(id) || included.has(id)) return false;
    included.add(id);
    return true;
  });
}

// Диалог только для его участников; чужой или несуществующий — null
async function getForUser(conversationId, userId, { populate = false } = {}) {
  if (!mongoose.isValidObjectId(conversationId)) return null;
  const query = Conversation.findOne({ _id: conversationId, participants: userId });
  return populate ? query.populate('participants', PEER_FIELDS) : query;
}

async function listMessages(conversationId, userId, { before } = {}) {
  const filter = await visibilityFilter(conversationId, userId, before);
  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(PAGE_SIZE)
    .populate('sender', PEER_FIELDS);
  return docs.reverse();
}

async function createMessage(conversation, senderId, text, content = {}, sender = null) {
  const message = await Message.create({ ...content, sender: senderId, text, conversation: conversation._id });
  // Диалог могли удалить «у обоих» между проверкой доступа и записью: не оставляем сиротское сообщение
  if (!(await Conversation.exists({ _id: conversation._id, participants: senderId }))) {
    await Message.deleteOne({ _id: message._id });
    throw new ChatGoneError();
  }
  // Новое сообщение возвращает чат тем, кто его скрыл (история, очищенная ими ранее, не вернётся)
  await Promise.all([
    ConversationState.updateMany({ conversation: conversation._id }, { hidden: false }),
    Conversation.updateOne({ _id: conversation._id },
      { lastMessageAt: message.sentAt, lastMessageText: text || message.attachment?.name || '' }),
  ]);
  // The authenticated sender is already loaded for this request.
  if (sender) { message.sender = sender; return message; }
  return message.populate('sender', PEER_FIELDS);
}

// Собеседник и превью — свои для каждого участника. Статус собеседника — с учетом его настройки
function buildConversationDto(conversation, userId, preview, unreadCount = 0, peerLastReadMessageId = null, pinnedAt = null) {
  const isGroup = conversation.kind === 'group';
  const isSaved = conversation.kind === 'saved';
  const peer = conversation.participants.find((p) => String(p._id) !== String(userId));
  return {
    id: conversation._id.toString(),
    kind: isSaved ? 'saved' : isGroup ? 'group' : 'direct',
    title: isGroup ? conversation.title : null,
    memberCount: conversation.participants.length,
    ownerId: isGroup ? String(conversation.owner) : null,
    adminIds: isGroup ? (conversation.admins ?? []).map(String) : [],
    pinnedAt: pinnedAt ? new Date(pinnedAt).toISOString() : null,
    peer: !isGroup && !isSaved && peer
      ? {
          id: peer._id.toString(),
          displayName: peer.displayName,
          status: accountStatus(peer.status),
          username: peer.username ?? null,
          avatarUrl: peer.avatarUrl ?? null,
          presence: presence.visibleStatus(peer),
          lastSeenAt: presence.visiblePresence(peer).lastSeenAt,
        }
      : null,
    lastMessageText: preview.text,
    lastMessageId: preview.id ?? null,
    lastMessageType: preview.type ?? 'text',
    lastMessageAt: (preview.at ?? conversation.createdAt ?? new Date()).toISOString(),
    unreadCount,
    peerLastReadMessageId: peerLastReadMessageId ? String(peerLastReadMessageId) : null,
  };
}

async function toConversationDto(conversation, userId) {
  const [ownState, hiddenIds, peerLastReadMessageId] = await Promise.all([
    ConversationState.findOne({ conversation: conversation._id, user: userId }),
    MessageHide.distinct('message', { conversation: conversation._id, user: userId }),
    peerReadCursor(conversation, userId),
  ]);
  const filter = { conversation: conversation._id, sentAt: { $gt: ownState?.clearedBefore ?? EPOCH }, _id: { $nin: hiddenIds } };
  const unreadFilter = { ...filter, _id: { ...filter._id }, sender: { $ne: userId } };
  if (ownState?.lastReadMessageId) unreadFilter._id.$gt = ownState.lastReadMessageId;
  const [last, unreadCount] = await Promise.all([
    Message.findOne(filter).sort({ _id: -1 }),
    conversation.kind === 'saved' ? 0 : Message.countDocuments(unreadFilter),
  ]);
  const preview = last ? { id: String(last._id), text: last.text || last.attachment?.name || '', at: last.sentAt,
    type: last.text ? 'text' : last.attachment?.kind ?? 'file' } : { text: '', at: null };
  return buildConversationDto(conversation, userId, preview, unreadCount, peerLastReadMessageId, ownState?.pinnedAt);
}

async function peerReadCursor(conversation, userId, knownStates) {
  if (conversation.kind === 'saved') return null;
  const peers = conversation.participants.map((p) => String(p._id ?? p)).filter((id) => id !== String(userId));
  const states = knownStates ?? await ConversationState.find({ conversation: conversation._id, user: { $in: peers } });
  return states.filter((state) => String(state.conversation) === String(conversation._id) && peers.includes(String(state.user)))
    .map((state) => state.lastReadMessageId ? String(state.lastReadMessageId) : null).filter(Boolean).sort().at(-1) ?? null;
}

// Список диалогов: состояния и скрытия загружаем одним запросом на всех, а не по диалогу
async function listDtosForUser(userId) {
  const docs = await listForUser(userId);
  if (docs.length === 0) return [];
  const ids = docs.map((c) => c._id);
  const [states, hides] = await Promise.all([
    ConversationState.find({ conversation: { $in: ids } }),
    MessageHide.find({ conversation: { $in: ids }, user: userId }),
  ]);

  const stateByConversation = new Map(states.filter((st) => String(st.user) === String(userId)).map((st) => [String(st.conversation), st]));
  const hiddenByConversation = new Map();
  for (const h of hides) {
    const key = String(h.conversation);
    if (!hiddenByConversation.has(key)) hiddenByConversation.set(key, []);
    hiddenByConversation.get(key).push(String(h.message));
  }

  const result = await Promise.all(
    docs.map(async (c) => {
      const key = String(c._id);
      const state = stateByConversation.get(key);
      const filter = {
        conversation: c._id,
        sentAt: { $gt: state?.clearedBefore ?? EPOCH },
        _id: { $nin: hiddenByConversation.get(key) ?? [] },
      };
      const unreadFilter = { ...filter, sender: { $ne: userId }, _id: { ...filter._id } };
      if (state?.lastReadMessageId) unreadFilter._id.$gt = state.lastReadMessageId;
      const [last, unreadCount] = await Promise.all([
        Message.findOne(filter).sort({ _id: -1 }),
        c.kind === 'saved' ? 0 : Message.countDocuments(unreadFilter),
      ]);
      const preview = last ? { id: String(last._id), text: last.text || last.attachment?.name || '', at: last.sentAt, type: last.text ? 'text' : last.attachment?.kind ?? 'file' } : { text: '', at: null };
      const cursor = await peerReadCursor(c, userId, states);
      return buildConversationDto(c, userId, preview, unreadCount, cursor, state?.pinnedAt);
    })
  );
  return result.sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) ||
    (a.pinnedAt && b.pinnedAt ? new Date(b.pinnedAt) - new Date(a.pinnedAt) : new Date(b.lastMessageAt) - new Date(a.lastMessageAt)));
}

async function getDtoForUser(conversationId, userId) {
  const doc = await getForUser(conversationId, userId, { populate: true });
  return doc ? toConversationDto(doc, userId) : null;
}

module.exports = {
  PAGE_SIZE,
  findOrCreateDirect,
  findOrCreateSaved,
  listForUser,
  getForUser,
  listMessages,
  createMessage,
  unhideFor,
  visibilityFilter,
  toConversationDto,
  listDtosForUser,
  getDtoForUser,
  previewFor,
  peerReadCursor,
  ChatGoneError,
};
