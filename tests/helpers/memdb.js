// Эмулятор нужных методов Mongoose в памяти для тестов. Схемы, ref, default и методы моделей — настоящие.
const mongoose = require('mongoose');

const stores = new Map();
const storeOf = (model) => {
  if (!stores.has(model.modelName)) stores.set(model.modelName, new Map());
  return stores.get(model.modelName);
};

const isOid = (v) => v instanceof mongoose.Types.ObjectId;
const isDate = (v) => v instanceof Date;
const isOpCond = (c) => c && typeof c === 'object' && !isOid(c) && !isDate(c) && !Array.isArray(c) &&
  Object.keys(c).some((k) => k.startsWith('$'));

function norm(v) {
  if (v === undefined || v === null) return null;
  if (isDate(v)) return v.getTime();
  if (isOid(v)) return v.toHexString();
  if (typeof v === 'object' && v._id) return norm(v._id);
  return v;
}
function eq(value, cond) {
  if (Array.isArray(value) && Array.isArray(cond)) return value.length === cond.length && value.every((item, index) => eq(item, cond[index]));
  if (Array.isArray(value)) return value.some((v) => eq(v, cond));
  const a = norm(value);
  const b = norm(cond);
  if (b === null) return a === null;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}
function matchCond(value, cond) {
  if (!isOpCond(cond)) return eq(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$in': if (!arg.some((x) => eq(value, x))) return false; break;
      case '$nin': if (arg.some((x) => eq(value, x))) return false; break;
      case '$ne': if (eq(value, arg)) return false; break;
      case '$gt': if (!(norm(value) > norm(arg))) return false; break;
      case '$lt': if (!(norm(value) < norm(arg))) return false; break;
      case '$gte': if (!(norm(value) >= norm(arg))) return false; break;
      case '$lte': if (!(norm(value) <= norm(arg))) return false; break;
      case '$regex': if (!new RegExp(arg).test(String(norm(value) ?? ''))) return false; break;
      default: throw new Error(`memdb: неподдерживаемый оператор ${op}`);
    }
  }
  return true;
}
function matches(doc, filter) {
  return Object.keys(filter).every((key) => {
    if (key === '$or') return filter.$or.some((f) => matches(doc, f));
    const value = key.split('.').reduce((current, part) => current?.[part], doc);
    return matchCond(value, filter[key]);
  });
}
function cmp(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}
function sortDocs(list, spec) {
  const keys = Object.entries(spec);
  return [...list].sort((x, y) => {
    for (const [key, dir] of keys) {
      const c = cmp(norm(x[key]), norm(y[key]));
      if (c) return c * dir;
    }
    return 0;
  });
}

function applyDefaults(model, data) {
  if (!data._id) data._id = new mongoose.Types.ObjectId();
  for (const [p, st] of Object.entries(model.schema.paths)) {
    if (p === '_id' || p === '__v') continue;
    const def = st.options?.default;
    if (data[p] === undefined && def !== undefined) {
      data[p] = typeof def === 'function' ? def() : def;
    }
  }
  if (model.schema.options.timestamps) {
    const now = new Date();
    data.createdAt = data.createdAt ?? now;
    data.updatedAt = now;
  }
  return data;
}

function applyUpdate(model, d, update, isInsert) {
  if (update && Object.keys(update).some((k) => k.startsWith('$'))) {
    if (update.$set) Object.assign(d, update.$set);
    if (isInsert && update.$setOnInsert) Object.assign(d, update.$setOnInsert);
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete d[k];
    if (update.$inc) for (const [k, value] of Object.entries(update.$inc)) d[k] = (d[k] ?? 0) + value;
    if (update.$max) for (const [k, v] of Object.entries(update.$max)) {
      if (d[k] == null || cmp(norm(d[k]), norm(v)) < 0) d[k] = v;
    }
  } else if (update) {
    Object.assign(d, update);
  }
  if (model.schema.options.timestamps) d.updatedAt = new Date();
}

const rawMatches = (model, filter) => [...storeOf(model).values()].filter((d) => matches(d, filter));
const findRaw = (model, filter) => rawMatches(model, filter)[0] ?? null;

function refFor(model, p) {
  const st = model.schema.path(p);
  return st?.options?.ref ?? st?.caster?.options?.ref ?? st?.options?.type?.[0]?.ref;
}

function hydrate(model, data) {
  if (!data) return null;
  const doc = { ...data };
  for (const [name, fn] of Object.entries(model.schema.methods)) {
    Object.defineProperty(doc, name, { value: fn.bind(doc), enumerable: false, configurable: true });
  }
  Object.defineProperty(doc, 'save', {
    enumerable: false,
    configurable: true,
    value: async () => {
      const snapshot = { ...doc };
      if (model.schema.options.timestamps) snapshot.updatedAt = new Date();
      storeOf(model).set(String(doc._id), snapshot);
      return doc;
    },
  });
  Object.defineProperty(doc, 'populate', {
    enumerable: false,
    configurable: true,
    value: async (p) => {
      await populateField(doc, model, p);
      return doc;
    },
  });
  return doc;
}

async function populateField(doc, model, p) {
  const ref = mongoose.model(refFor(model, p));
  const raw = doc[p];
  // ObjectId у Mongoose тоже имеет геттер _id, поэтому отличаем по isOid
  const isPopulated = (v) => v && typeof v === 'object' && !isOid(v) && v._id !== undefined;
  if (Array.isArray(raw)) {
    doc[p] = raw
      .map((id) => (isPopulated(id) ? id : hydrate(ref, findRaw(ref, { _id: id }))))
      .filter(Boolean);
  } else if (isPopulated(raw)) {
    // уже популирован
  } else {
    doc[p] = raw ? hydrate(ref, findRaw(ref, { _id: raw })) : null;
  }
}

function query(model, filter, one) {
  const q = { sort: null, limit: null, populate: [] };
  const exec = async () => {
    let list = rawMatches(model, filter);
    if (q.sort) list = sortDocs(list, q.sort);
    if (q.limit != null) list = list.slice(0, q.limit);
    const docs = list.map((d) => hydrate(model, d));
    for (const doc of docs) for (const p of q.populate) await populateField(doc, model, p);
    return one ? (docs[0] ?? null) : docs;
  };
  const chain = {
    sort(spec) { q.sort = spec; return chain; },
    limit(n) { q.limit = n; return chain; },
    select() { return chain; },
    populate(p) { q.populate.push(p); return chain; },
    then(res, rej) { return exec().then(res, rej); },
  };
  return chain;
}

function equalityFields(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter)) if (!isOpCond(v)) out[k] = v;
  return out;
}

function install(model) {
  storeOf(model);
  model.find = (filter = {}) => query(model, filter, false);
  model.findOne = (filter = {}) => query(model, filter, true);
  model.findById = (id) => query(model, { _id: id }, true);
  model.exists = async (filter) => {
    const d = findRaw(model, filter);
    return d ? { _id: d._id } : null;
  };
  model.create = async (data) => {
    const d = applyDefaults(model, { ...data });
    storeOf(model).set(String(d._id), d);
    return hydrate(model, d);
  };
  model.updateOne = async (filter, update) => {
    const d = findRaw(model, filter);
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(model, d, update, false);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  model.updateMany = async (filter, update) => {
    const list = rawMatches(model, filter);
    list.forEach((d) => applyUpdate(model, d, update, false));
    return { matchedCount: list.length, modifiedCount: list.length };
  };
  model.findOneAndUpdate = async (filter, update, opts = {}) => {
    let d = findRaw(model, filter);
    if (!d) {
      if (!opts.upsert) return null;
      d = applyDefaults(model, equalityFields(filter));
      applyUpdate(model, d, update, true);
      storeOf(model).set(String(d._id), d);
      return hydrate(model, d);
    }
    applyUpdate(model, d, update, false);
    return hydrate(model, d);
  };
  model.deleteOne = async (filter) => {
    const d = findRaw(model, filter);
    if (d) storeOf(model).delete(String(d._id));
    return { deletedCount: d ? 1 : 0 };
  };
  model.deleteMany = async (filter) => {
    const list = rawMatches(model, filter);
    list.forEach((d) => storeOf(model).delete(String(d._id)));
    return { deletedCount: list.length };
  };
  model.distinct = async (field, filter = {}) => [
    ...new Set(rawMatches(model, filter).map((d) => d[field]).filter((v) => v !== undefined && v !== null).map(String)),
  ];
  model.countDocuments = async (filter = {}) => rawMatches(model, filter).length;
  return model;
}

function resetAll() {
  for (const s of stores.values()) s.clear();
}

module.exports = { install, resetAll, storeOf };
