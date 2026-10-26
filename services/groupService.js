const crypto = require('crypto');
const mongoose = require('mongoose');
const { Conversation } = require('../models/Conversation');
const { User } = require('../models/User');
const { Message } = require('../modules/messages/message.model');
const { ConversationState } = require('../models/ConversationState');
const { MessageHide } = require('../models/MessageHide');

const MAX_MEMBERS = 100;
const ids = (values) => [...new Set((values ?? []).map((value) => String(value._id ?? value)))];
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const isOwner = (group, userId) => String(group.owner) === String(userId);
const isAdmin = (group, userId) => isOwner(group, userId) || ids(group.admins).includes(String(userId));

function titleValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw fail(400, 'group_title_invalid', 'Название группы: от 1 до 80 символов');
  return value.trim();
}

async function validateMembers(values) {
  if (!Array.isArray(values) || values.length > MAX_MEMBERS || !values.every((id) => mongoose.isValidObjectId(id))) {
    throw fail(400, 'group_members_invalid', 'Некорректный список участников');
  }
  const unique = ids(values);
  if (await User.countDocuments({ _id: { $in: unique } }) !== unique.length) throw fail(404, 'user_not_found', 'Пользователь не найден');
  return unique;
}

async function getGroup(groupId, userId) {
  if (!mongoose.isValidObjectId(groupId)) throw fail(404, 'conversation_not_found', 'Группа недоступна');
  const group = await Conversation.findOne({ _id: groupId, kind: 'group', participants: userId });
  if (!group) throw fail(404, 'conversation_not_found', 'Группа недоступна');
  return group;
}

async function create(userId, title, memberIds = []) {
  const participants = ids([userId, ...await validateMembers(memberIds)]);
  if (participants.length > MAX_MEMBERS) throw fail(400, 'group_full', 'В группе не больше 100 участников');
  const _id = new mongoose.Types.ObjectId();
  return Conversation.create({ _id, kind: 'group', title: titleValue(title), owner: userId,
    participants, admins: [userId], membershipVersion: 0, directKey: `group:${_id}` });
}

// Membership and role changes use compare-and-swap so concurrent edits cannot lose members or permissions.
async function change(groupId, userId, action) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const group = await getGroup(groupId, userId);
    const update = await action(group);
    const changed = await Conversation.findOneAndUpdate(
      { _id: group._id, membershipVersion: group.membershipVersion ?? 0 },
      { $set: update, $inc: { membershipVersion: 1 } }, { new: true }
    );
    if (changed) return { before: group, group: changed };
  }
  throw fail(409, 'group_changed', 'Группа изменилась, попробуйте ещё раз');
}

function requireAdmin(group, userId) { if (!isAdmin(group, userId)) throw fail(403, 'group_admin_required', 'Нужны права администратора'); }
function requireOwner(group, userId) { if (!isOwner(group, userId)) throw fail(403, 'group_owner_required', 'Действие доступно владельцу'); }

const rename = (groupId, userId, title) => change(groupId, userId, (group) => { requireAdmin(group, userId); return { title: titleValue(title) }; });

async function addMembers(groupId, userId, memberIds) {
  const additions = await validateMembers(memberIds);
  return change(groupId, userId, (group) => {
    requireAdmin(group, userId);
    const participants = ids([...group.participants, ...additions]);
    if (participants.length > MAX_MEMBERS) throw fail(400, 'group_full', 'В группе не больше 100 участников');
    return { participants };
  });
}

const removeMember = (groupId, userId, targetId) => change(groupId, userId, (group) => {
  requireAdmin(group, userId);
  if (String(targetId) === String(group.owner)) throw fail(403, 'group_owner_required', 'Владельца нельзя удалить');
  if (isAdmin(group, targetId) && !isOwner(group, userId)) throw fail(403, 'group_owner_required', 'Действие доступно владельцу');
  return { participants: ids(group.participants).filter((id) => id !== String(targetId)), admins: ids(group.admins).filter((id) => id !== String(targetId)) };
});

const setAdmin = (groupId, userId, targetId, admin) => change(groupId, userId, (group) => {
  requireOwner(group, userId);
  if (typeof admin !== 'boolean' || !ids(group.participants).includes(String(targetId))) throw fail(400, 'group_members_invalid', 'Участник не найден');
  if (String(targetId) === String(group.owner)) throw fail(403, 'group_owner_required', 'Владелец остаётся администратором');
  const admins = ids(group.admins).filter((id) => id !== String(targetId));
  if (admin) admins.push(String(targetId));
  return { admins };
});

const transferOwner = (groupId, userId, targetId) => change(groupId, userId, (group) => {
  requireOwner(group, userId);
  if (!ids(group.participants).includes(String(targetId))) throw fail(400, 'group_members_invalid', 'Участник не найден');
  return { owner: targetId, admins: ids([...group.admins, targetId]) };
});

const leave = (groupId, userId) => change(groupId, userId, (group) => {
  if (isOwner(group, userId)) throw fail(400, 'group_transfer_required', 'Сначала передайте права владельца другому участнику');
  return { participants: ids(group.participants).filter((id) => id !== String(userId)), admins: ids(group.admins).filter((id) => id !== String(userId)) };
});

async function remove(groupId, userId) {
  const group = await getGroup(groupId, userId);
  requireOwner(group, userId);
  const deleted = await Conversation.deleteOne({ _id: group._id, owner: userId, membershipVersion: group.membershipVersion ?? 0 });
  if (!deleted.deletedCount) throw fail(409, 'group_changed', 'Группа изменилась, попробуйте ещё раз');
  await Message.deleteMany({ conversation: group._id });
  await MessageHide.deleteMany({ conversation: group._id });
  await ConversationState.deleteMany({ conversation: group._id });
  return group;
}

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
async function invite(groupId, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await change(groupId, userId, (group) => { requireAdmin(group, userId); return { inviteTokenHash: hash(token) }; });
  return token;
}

async function fromInvite(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw fail(404, 'group_invite_invalid', 'Приглашение недействительно');
  const group = await Conversation.findOne({ kind: 'group', inviteTokenHash: hash(token) });
  if (!group) throw fail(404, 'group_invite_invalid', 'Приглашение недействительно');
  return group;
}

async function join(token, userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const group = await fromInvite(token);
    if (ids(group.participants).includes(String(userId))) return { before: group, group };
    if (group.participants.length >= MAX_MEMBERS) throw fail(400, 'group_full', 'В группе не больше 100 участников');
    const changed = await Conversation.findOneAndUpdate(
      { _id: group._id, membershipVersion: group.membershipVersion ?? 0, inviteTokenHash: hash(token) },
      { $set: { participants: ids([...group.participants, userId]) }, $inc: { membershipVersion: 1 } }, { new: true }
    );
    if (changed) return { before: group, group: changed };
  }
  throw fail(409, 'group_changed', 'Группа изменилась, попробуйте ещё раз');
}

module.exports = { MAX_MEMBERS, ids, isAdmin, isOwner, getGroup, create, rename, addMembers,
  removeMember, setAdmin, transferOwner, leave, remove, invite, fromInvite, join };
