const groups = require('../services/groupService');
const conversations = require('../services/conversationService');
const realtime = require('../services/realtime');
const presence = require('../services/presence');
const { User } = require('../models/User');

async function get(req, res, next) {
  try {
    const group = await groups.getGroup(req.params.id, req.user._id);
    const members = await User.find({ _id: { $in: group.participants } });
    res.json({ group: {
      id: String(group._id), title: group.title, ownerId: String(group.owner), adminIds: groups.ids(group.admins),
      members: members.map((member) => ({ ...member.toPublicProfile(), ...{ presence: presence.visibleStatus(member), lastSeenAt: presence.visiblePresence(member).lastSeenAt } })),
    } });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const group = await groups.create(req.user._id, req.body?.title, req.body?.memberIds ?? []);
    realtime.toUsers(group.participants, 'chat:changed', { conversationId: String(group._id), reason: 'group-updated' });
    res.status(201).json({ conversation: await conversations.getDtoForUser(group._id, req.user._id) });
  } catch (err) { next(err); }
}

function mutation(action) {
  return async (req, res, next) => {
    try {
      const { before, group } = await action(req);
      const remaining = groups.ids(group.participants);
      const removed = groups.ids(before.participants).filter((id) => !remaining.includes(id));
      if (removed.length) realtime.toUsers(removed, 'chat:changed', { conversationId: String(group._id), reason: 'removed' });
      realtime.toUsers(remaining, 'chat:changed', { conversationId: String(group._id), reason: 'group-updated' });
      res.json({ ok: true, conversation: remaining.includes(String(req.user._id)) ? await conversations.getDtoForUser(group._id, req.user._id) : null });
    } catch (err) { next(err); }
  };
}

async function remove(req, res, next) {
  try {
    const group = await groups.remove(req.params.id, req.user._id);
    realtime.toUsers(group.participants, 'chat:changed', { conversationId: String(group._id), reason: 'deleted' });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

async function invite(req, res, next) {
  try { res.json({ token: await groups.invite(req.params.id, req.user._id) }); } catch (err) { next(err); }
}
async function previewInvite(req, res, next) {
  try {
    const group = await groups.fromInvite(req.params.token);
    res.json({ group: { title: group.title, memberCount: group.participants.length, alreadyMember: groups.ids(group.participants).includes(String(req.user._id)) } });
  } catch (err) { next(err); }
}

module.exports = {
  get, create, remove, invite, previewInvite,
  rename: mutation((r) => groups.rename(r.params.id, r.user._id, r.body?.title)),
  addMembers: mutation((r) => groups.addMembers(r.params.id, r.user._id, r.body?.memberIds)),
  removeMember: mutation((r) => groups.removeMember(r.params.id, r.user._id, r.params.userId)),
  setAdmin: mutation((r) => groups.setAdmin(r.params.id, r.user._id, r.params.userId, r.body?.admin)),
  transferOwner: mutation((r) => groups.transferOwner(r.params.id, r.user._id, r.body?.userId)),
  leave: mutation((r) => groups.leave(r.params.id, r.user._id)),
  join: mutation((r) => groups.join(r.params.token, r.user._id)),
};
