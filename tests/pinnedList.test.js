const { memdb } = require('./helpers/setup');
const { beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { User } = require('../models/User');
const { Conversation } = require('../models/Conversation');
const { ConversationState } = require('../models/ConversationState');
const conversations = require('../services/conversationService');

// Match MongoDB's actual return type; the general emulator's distinct returns strings.
const originalDistinct = ConversationState.distinct;
ConversationState.distinct = async (...args) => (await originalDistinct(...args)).map((id) => new mongoose.Types.ObjectId(id));
after(() => { ConversationState.distinct = originalDistinct; });
beforeEach(() => memdb.resetAll());

const user = (name) => User.create({ email: `${name}@pinned-list.test`, displayName: name });
const pin = (conversation, owner, change = {}) => ConversationState.create({
  conversation: conversation._id, user: owner._id, pinnedAt: new Date('2026-10-27T12:00:00Z'), ...change,
});

test('pinned recent direct chats and Saved Messages appear once with MongoDB ObjectId distinct values', async () => {
  const [owner, peer] = await Promise.all([user('owner'), user('peer')]);
  const [saved, direct] = await Promise.all([
    conversations.findOrCreateSaved(owner._id), conversations.findOrCreateDirect(owner._id, peer._id),
  ]);
  await Promise.all([pin(saved, owner), pin(direct, owner)]);
  const result = await conversations.listDtosForUser(owner._id);
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map((entry) => entry.id)), new Set([String(saved._id), String(direct._id)]));
  assert.equal(result.filter((entry) => entry.kind === 'saved').length, 1);
});

test('a hidden pinned chat stays hidden when separate ObjectId instances refer to the same conversation', async () => {
  const owner = await user('owner');
  const saved = await conversations.findOrCreateSaved(owner._id);
  await pin(saved, owner, { hidden: true });
  const hidden = await ConversationState.distinct('conversation', { user: owner._id, hidden: true });
  const pinned = await ConversationState.distinct('conversation', { user: owner._id, pinnedAt: { $ne: null } });
  assert.ok(hidden[0] instanceof mongoose.Types.ObjectId);
  assert.notEqual(hidden[0], pinned[0]);
  assert.equal(String(hidden[0]), String(pinned[0]));
  assert.deepEqual(await conversations.listForUser(owner._id), []);
});

test('old pinned chats beyond the newest 100 are included once and hidden or foreign pinned chats stay excluded', async () => {
  const [owner, outsider] = await Promise.all([user('owner'), user('outsider')]);
  const saved = await conversations.findOrCreateSaved(owner._id);
  await Conversation.updateOne({ _id: saved._id }, { lastMessageAt: new Date('2000-01-01T00:00:00Z') });
  await pin(saved, owner);
  const hidden = await Conversation.create({ kind: 'group', title: 'Hidden', owner: owner._id,
    participants: [owner._id], directKey: 'hidden', lastMessageAt: new Date('2000-01-01T00:00:00Z') });
  await pin(hidden, owner, { hidden: true });
  const foreign = await conversations.findOrCreateSaved(outsider._id);
  await pin(foreign, owner);
  for (let index = 0; index < 101; index++) {
    await Conversation.create({ kind: 'group', title: `Recent ${index}`, owner: owner._id,
      participants: [owner._id], directKey: `recent-${index}`, lastMessageAt: new Date(2026, 9, 27, 12, 0, index) });
  }
  const result = await conversations.listForUser(owner._id);
  const ids = result.map((entry) => String(entry._id));
  assert.equal(result.length, 101);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === String(saved._id)).length, 1);
  assert.ok(!ids.includes(String(hidden._id)));
  assert.ok(!ids.includes(String(foreign._id)));
});
