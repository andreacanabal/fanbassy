const { query, withTransaction } = require('../db');

const makeErr = (msg, status) => Object.assign(new Error(msg), { status });

// Core: add a transaction and update wallet balance atomically
const addTx = async (c, { userId, type, amount, description, metadata = {} }) => {
  const { rows } = await c.query(
    'SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE',
    [userId]
  );
  if (!rows[0]) throw makeErr('Wallet no encontrada', 404);

  const before = parseFloat(rows[0].balance);
  const after  = Math.round((before + amount) * 100) / 100;
  if (after < 0) throw makeErr('Saldo insuficiente', 400);

  await c.query(
    'UPDATE wallets SET balance=$1, updated_at=NOW() WHERE user_id=$2',
    [after, userId]
  );
  await c.query(
    `INSERT INTO transactions
     (user_id, type, amount, balance_before, balance_after, description, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, type, amount, before, after, description, JSON.stringify(metadata)]
  );
  return { before, after };
};

const deposit = async (userId, amount) => {
  if (!amount || amount < 1) throw makeErr('Mínimo $1 USD', 400);
  if (amount > 10000)        throw makeErr('Máximo $10,000 USD por depósito', 400);

  return withTransaction(async (c) => {
    const result = await addTx(c, {
      userId, type: 'deposit', amount,
      description: 'Depósito SPEI',
    });

    await c.query(
      'UPDATE wallets SET total_deposited = total_deposited + $1 WHERE user_id = $2',
      [amount, userId]
    );

    // Pay affiliate commission if user was referred
    const { rows } = await c.query(
      `SELECT a.user_id, a.commission_pct
       FROM users u
       JOIN affiliates a ON a.user_id = u.referred_by
       WHERE u.id = $1 AND a.is_active = true`,
      [userId]
    );
    if (rows[0]) {
      const commission = Math.round(amount * 0.05 * parseFloat(rows[0].commission_pct) * 100) / 100;
      if (commission > 0) {
        await addTx(c, {
          userId: rows[0].user_id,
          type: 'affiliate',
          amount: commission,
          description: `Comisión de referido`,
          metadata: { referredUserId: userId },
        });
        await c.query(
          'UPDATE affiliates SET total_earned = total_earned + $1 WHERE user_id = $2',
          [commission, rows[0].user_id]
        );
      }
    }

    return result;
  });
};

const withdraw = async (userId, amount, clabe) => {
  if (!amount || amount < 5) throw makeErr('Mínimo $5 USD para retirar', 400);
  if (!clabe || !/^\d{18}$/.test(clabe)) throw makeErr('CLABE debe tener exactamente 18 dígitos', 400);

  return withTransaction(async (c) => {
    const result = await addTx(c, {
      userId, type: 'withdrawal', amount: -amount,
      description: 'Retiro SPEI',
      metadata: { clabe: clabe.slice(0, 6) + '****' + clabe.slice(-4) },
    });
    await c.query(
      'INSERT INTO withdrawals (user_id, amount, clabe) VALUES ($1,$2,$3)',
      [userId, amount, clabe]
    );
    return result;
  });
};

const getBalance = async (userId) => {
  const { rows } = await query(
    'SELECT balance, total_deposited, total_withdrawn, total_won FROM wallets WHERE user_id=$1',
    [userId]
  );
  return rows[0] || null;
};

const getTransactions = async (userId, limit = 50) => {
  const { rows } = await query(
    `SELECT id, type, amount, balance_before, balance_after, description, created_at
     FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

module.exports = { deposit, withdraw, getBalance, getTransactions, addTx };
