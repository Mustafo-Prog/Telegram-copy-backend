const TTL_MS = 5000;
const sessions = new Map();
let deliver = null;

function publish(entry, active) {
  deliver?.(entry.audience, { scope: entry.conversationId ? 'conversation' : 'general', conversationId: entry.conversationId,
    userId: entry.userId, displayName: entry.displayName, active, ttl: TTL_MS });
}

function prune(entry, now = Date.now()) {
  for (const [socketId, until] of entry.sockets) if (until <= now) entry.sockets.delete(socketId);
}

function attach(callback) {
  deliver = callback;
  const timer = setInterval(() => {
    for (const [key, entry] of sessions) {
      prune(entry);
      if (!entry.sockets.size) { publish(entry, false); sessions.delete(key); }
    }
  }, 1000);
  timer.unref?.();
}

function set({ socketId, userId, displayName, conversationId = null, audience = null, active }) {
  const key = `${conversationId ?? 'general'}:${userId}`;
  let entry = sessions.get(key);
  if (!entry && !active) return;
  if (!entry) entry = { userId: String(userId), displayName, conversationId, audience, sockets: new Map() };
  entry.audience = audience;
  entry.displayName = displayName;
  prune(entry);
  if (active) entry.sockets.set(socketId, Date.now() + TTL_MS);
  else entry.sockets.delete(socketId);
  if (entry.sockets.size) { sessions.set(key, entry); publish(entry, true); }
  else { sessions.delete(key); publish(entry, false); }
}

function stopSocket(socketId) {
  for (const [key, entry] of sessions) {
    entry.sockets.delete(socketId);
    prune(entry);
    if (!entry.sockets.size) { sessions.delete(key); publish(entry, false); }
  }
}

function stopUser(userId) {
  for (const [key, entry] of sessions) if (entry.userId === String(userId)) {
    sessions.delete(key); publish(entry, false);
  }
}

module.exports = { attach, set, stopSocket, stopUser, TTL_MS };
