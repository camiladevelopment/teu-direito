const session = require('express-session');
const { db } = require('./database');

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare(`
        SELECT data FROM sessions WHERE sid = ? AND expires_at > ?
      `).get(sid, Date.now());
      if (!row) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (1000 * 60 * 60 * 12);
      db.prepare(`
        INSERT INTO sessions (sid, data, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE
        SET data = excluded.data, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(value), expiresAt);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (1000 * 60 * 60 * 12);
      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = SQLiteSessionStore;