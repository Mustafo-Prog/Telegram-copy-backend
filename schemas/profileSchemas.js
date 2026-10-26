const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

// "@Ivan_77" -> "ivan_77"
function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
}

// Возвращает { values } с только переданными полями или { error: код }
function validateProfile(body = {}) {
  const values = {};

  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!name || name.length > 50) return { error: 'displayname_invalid' };
    values.displayName = name;
  }

  if (body.username !== undefined) {
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) return { error: 'username_invalid' };
    values.username = username;
  }

  if (body.bio !== undefined) {
    if (typeof body.bio !== 'string' || body.bio.trim().length > 150) return { error: 'bio_too_long' };
    values.bio = body.bio.trim();
  }

  if (Object.keys(values).length === 0) return { error: 'nothing_to_update' };
  return { values };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { validateProfile, normalizeUsername, escapeRegex, USERNAME_RE };
