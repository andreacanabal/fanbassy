const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query, withTransaction } = require('../db');

const makeErr = (msg, status) => Object.assign(new Error(msg), { status });

const sign = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const register = async ({ email, username, password, refCode }) => {
  if (!email || !email.includes('@'))  throw makeErr('Email inválido', 400);
  if (!password || password.length < 6) throw makeErr('Password mínimo 6 caracteres', 400);
  if (!username || username.length < 3) throw makeErr('Usuario mínimo 3 caracteres', 400);

  return withTransaction(async (c) => {
    const dup = await c.query(
      'SELECT id FROM users WHERE email=$1 OR username=$2', [email.toLowerCase(), username]
    );
    if (dup.rows.length) throw makeErr('Email o usuario ya existe', 400);

    let referredBy = null;
    if (refCode) {
      const r = await c.query(
        'SELECT user_id FROM affiliates WHERE code=$1 AND is_active=true',
        [refCode.toUpperCase()]
      );
      if (r.rows[0]) referredBy = r.rows[0].user_id;
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await c.query(
      `INSERT INTO users (email, username, password_hash, referred_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, role`,
      [email.toLowerCase(), username, hash, referredBy]
    );

    await c.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);

    const code = username.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
      + Math.random().toString(36).slice(2, 5).toUpperCase();
    await c.query(
      'INSERT INTO affiliates (user_id, code) VALUES ($1, $2)', [user.id, code]
    );

    if (referredBy) {
      await c.query(
        'UPDATE affiliates SET total_referrals = total_referrals + 1 WHERE user_id = $1',
        [referredBy]
      );
    }

    return { user, token: sign(user.id) };
  });
};

const login = async ({ email, password }) => {
  if (!email || !password) throw makeErr('Email y password requeridos', 400);

  const { rows } = await query(
    `SELECT id, email, username, role, password_hash
     FROM users WHERE email=$1 AND is_active=true`,
    [email.toLowerCase()]
  );
  if (!rows[0]) throw makeErr('Credenciales inválidas', 401);

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) throw makeErr('Credenciales inválidas', 401);

  const { password_hash, ...user } = rows[0];
  return { user, token: sign(user.id) };
};

const me = async (userId) => {
  const { rows } = await query(
    'SELECT id, email, username, role, created_at FROM users WHERE id=$1',
    [userId]
  );
  return rows[0] || null;
};

module.exports = { register, login, me };
