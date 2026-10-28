const REACTION_EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎']);

function reactionSummary(entries = []) {
  const usersByEmoji = new Map();
  for (const entry of entries) {
    if (!REACTION_EMOJIS.includes(entry.emoji)) continue;
    if (!usersByEmoji.has(entry.emoji)) usersByEmoji.set(entry.emoji, new Set());
    usersByEmoji.get(entry.emoji).add(String(entry.user));
  }
  return REACTION_EMOJIS.filter((emoji) => usersByEmoji.has(emoji)).map((emoji) => {
    const userIds = [...usersByEmoji.get(emoji)];
    return { emoji, count: userIds.length, userIds };
  });
}

module.exports = { REACTION_EMOJIS, reactionSummary };
