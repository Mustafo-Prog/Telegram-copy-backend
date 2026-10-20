function apiError(code, message, params) {
  return params ? { code, message, params } : { code, message };
}

module.exports = { apiError };
