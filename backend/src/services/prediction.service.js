const { query, withTransaction } = require('../db');
const { addTx } = require('./wallet.service');

const COMMISSION = 0.05;
const HOUSE_USER_ID = '00000000-0000-0000-0000-000000000001'; // admin wallet

const TEMPLATES = [
  { type:'A', question:'Quien tiene el siguiente tiro de esquina?', options:['🇪🇸 Espana','🇵🇪 Peru'], dur:25, nullLabel:'Revision VAR' },
  { type:'A', question:'Habra falta en los proximos 3 minutos?',    options:['Si','No'],                dur:30, nullLabel:'Lesion' },
  { type:'A', question:'Quien gana el siguiente duelo aereo?',       options:['🇪🇸 Espana','🇵🇪 Peru'], dur:20, nullLabel:'Tiempo medico' },
  { type:'A', question:'Habra sustitucion antes del min 75?',        options:['Si','No'],                dur:35, nullLabel:'Revision VAR' },
  { type:'A', question:'Proximo tiro al arco?',                      options:['🇪🇸 Espana','🇵🇪 Peru'], dur:28, nullLabel:'Lesion' },
  { type:'A', question:'Habra tarjeta en los proximos 5 min?',       options:['Si','No'],                dur:32, nullLabel:'Revision VAR' },
  { type:'B', question:'Que pasa en el siguiente corner?',           options:['Despejan','Tiro al arco','Gol directo'], dur:30, tripleIdx:2, tripleLabel:'Gol directo' },
  { type:'B', question:'Resultado del siguiente tiro libre?',        options:['Bloqueado','Fuera','Gol directo'],       dur:28, tripleIdx:2, tripleLabel:'Gol directo' },
];

const JACKPOT_EVENTS = [
  { question:'JACKPOT - Gol en los proximos 60 segundos?',      multiplier:8,  dur:60 },
  { question:'JACKPOT - Penalti en los proximos 45 segundos?',  multiplier:10, dur:45 },
  { question:'JACKPOT - Tarjeta ROJA en 60 segundos?',          multiplier:12, dur:60 },
];

let _templateIdx = 0;
let _predCount   = 0;

const createPrediction = async (matchId) => {
  _predCount++;
  let t;
  if (_predCount % 8 === 0) {
    const jp = JACKPOT_EVENTS[Math.floor(Math.random() * JACKPOT_EVENTS.length)];
    t = { type:'C', question:jp.question, options:['Si ocurre','No ocurre'],
          dur:jp.dur, multiplier:jp.multiplier, tripleIdx:null, nullLabel:null };
  } else {
    t = TEMPLATES[(_templateIdx++) % TEMPLATES.length];
  }

  const votes = t.options.map((_, i) => {
    if (t.type === 'B' && i === t.tripleIdx)  return Math.floor(Math.random() * 8) + 2;
    if (t.type === 'C' && i === 0)            return Math.floor(Math.random() * 12) + 3;
    return Math.floor(Math.random() * 200) + 50;
  });
  const pools = votes.map(v => parseFloat((v * 1.0).toFixed(2)));
  const totalPool = pools.reduce((a, b) => a + b, 0);
  const closesAt = new Date(Date.now() + t.dur * 1000);

  const { rows: [pred] } = await query(
    `INSERT INTO predictions
     (match_id, type, question, options, votes, pools, total_pool, duration_sec,
      closes_at, null_label, triple_idx, multiplier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [matchId, t.type, t.question, JSON.stringify(t.options),
     JSON.stringify(votes), JSON.stringify(pools), totalPool, t.dur,
     closesAt, t.nullLabel || null, t.tripleIdx != null ? t.tripleIdx : null,
     t.multiplier || null]
  );
  return pred;
};

const resolvePrediction = async (predId) => {
  const { rows: [pred] } = await query(
    "SELECT * FROM predictions WHERE id=$1 AND status='open'",
    [predId]
  );
  if (!pred) return null;

  const bets = (await query('SELECT * FROM bets WHERE prediction_id=$1', [predId])).rows;
  const winner = Math.floor(Math.random() * pred.options.length);

  // Determine resolution mode
  const nullFired    = pred.type === 'A' && Math.random() < 0.06;
  const tripleFired  = pred.type === 'B' && pred.triple_idx != null && winner === pred.triple_idx;
  const jackpotFired = pred.type === 'C' && Math.random() < 0.04;

  let mode = 'normal', houseWin = false, houseSweep = 0, resolvedWinner = winner;

  await withTransaction(async (c) => {
    if (nullFired) {
      mode = 'null_event'; houseWin = true; houseSweep = parseFloat(pred.total_pool);
      resolvedWinner = -1;
      if (houseSweep > 0)
        await addTx(c, { userId:HOUSE_USER_ID, type:'sweep_null', amount:houseSweep, description:`Evento nulo: ${pred.null_label}` });
      for (const b of bets)
        await c.query("UPDATE bets SET status='lost', payout=0 WHERE id=$1", [b.id]);

    } else if (tripleFired) {
      mode = 'triple_c'; houseWin = true; houseSweep = parseFloat(pred.total_pool);
      resolvedWinner = pred.triple_idx;
      if (houseSweep > 0)
        await addTx(c, { userId:HOUSE_USER_ID, type:'sweep_triple', amount:houseSweep, description:'Triple resultado' });
      for (const b of bets)
        await c.query("UPDATE bets SET status='lost', payout=0 WHERE id=$1", [b.id]);

    } else if (jackpotFired) {
      mode = 'jackpot_hit'; houseWin = true; resolvedWinner = 0;
      houseSweep = Math.round(parseFloat(pred.total_pool) * 0.5 * 100) / 100;
      const winnersShare = parseFloat(pred.total_pool) - houseSweep;
      if (houseSweep > 0)
        await addTx(c, { userId:HOUSE_USER_ID, type:'sweep_jackpot', amount:houseSweep, description:'Jackpot' });
      const jpBets = bets.filter(b => b.option_idx === 0);
      const jpPool = jpBets.reduce((s, b) => s + parseFloat(b.amount), 0);
      for (const b of bets) {
        if (b.option_idx === 0 && jpPool > 0) {
          const payout = Math.round((parseFloat(b.amount) / jpPool) * winnersShare * 100) / 100;
          await c.query("UPDATE bets SET status='won', payout=$1, is_jackpot=true WHERE id=$2", [payout, b.id]);
          if (payout > 0) {
            await addTx(c, { userId:b.user_id, type:'win', amount:payout, description:'JACKPOT ACTIVADO' });
            await c.query('UPDATE wallets SET total_won = total_won + $1 WHERE user_id = $2', [payout, b.user_id]);
          }
        } else {
          await c.query("UPDATE bets SET status='lost', payout=0 WHERE id=$1", [b.id]);
        }
      }

    } else {
      // Normal P2P distribution
      const pools = pred.pools;
      const wPool = parseFloat(pools[winner]) || 0;
      const lPool = parseFloat(pred.total_pool) - wPool;
      for (const b of bets) {
        if (b.option_idx === winner && wPool > 0) {
          const share  = parseFloat(b.amount) / wPool;
          const payout = Math.round((parseFloat(b.amount) + lPool * share * (1 - COMMISSION)) * 100) / 100;
          await c.query("UPDATE bets SET status='won', payout=$1 WHERE id=$2", [payout, b.id]);
          await addTx(c, { userId:b.user_id, type:'win', amount:payout, description:'Ganaste prediccion' });
          await c.query('UPDATE wallets SET total_won = total_won + $1 WHERE user_id = $2', [payout, b.user_id]);
        } else {
          await c.query("UPDATE bets SET status='lost', payout=0 WHERE id=$1", [b.id]);
        }
      }
    }

    // Mark prediction resolved
    await c.query(
      `UPDATE predictions SET
       status='resolved', winner=$1, house_win=$2, house_sweep_amt=$3,
       resolve_mode=$4, resolved_at=NOW()
       WHERE id=$5`,
      [resolvedWinner, houseWin, houseSweep, mode, predId]
    );

    // Immutable audit log
    await c.query(
      `INSERT INTO audit_log
       (prediction_id, match_id, type, resolve_mode, total_pool,
        house_sweep_amt, winner_idx, bets_count, distribution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [predId, pred.match_id, pred.type, mode, pred.total_pool,
       houseSweep, resolvedWinner, bets.length,
       JSON.stringify({ mode, winner: resolvedWinner, bets: bets.length })]
    );
  });

  return { predId, mode, resolvedWinner, houseWin, houseSweep };
};

const placeBet = async (userId, predId, optIdx, amount) => {
  if (!amount || amount < 0.5) throw Object.assign(new Error('Apuesta mínima $0.50'), { status: 400 });

  return withTransaction(async (c) => {
    const { rows: [pred] } = await c.query(
      "SELECT * FROM predictions WHERE id=$1 AND status='open' FOR UPDATE",
      [predId]
    );
    if (!pred) throw Object.assign(new Error('Predicción no disponible'), { status: 400 });

    if (optIdx < 0 || optIdx >= pred.options.length)
      throw Object.assign(new Error('Opción inválida'), { status: 400 });

    const already = await c.query(
      'SELECT id FROM bets WHERE user_id=$1 AND prediction_id=$2', [userId, predId]
    );
    if (already.rows.length) throw Object.assign(new Error('Ya apostaste en esta predicción'), { status: 400 });

    await addTx(c, { userId, type: 'bet', amount: -amount, description: 'Apuesta colocada' });

    const votes = [...pred.votes]; votes[optIdx] = (votes[optIdx] || 0) + 1;
    const pools = [...pred.pools]; pools[optIdx] = Math.round(((parseFloat(pools[optIdx]) || 0) + amount) * 100) / 100;
    const totalPool = Math.round((parseFloat(pred.total_pool) + amount) * 100) / 100;

    await c.query(
      'UPDATE predictions SET votes=$1, pools=$2, total_pool=$3 WHERE id=$4',
      [JSON.stringify(votes), JSON.stringify(pools), totalPool, predId]
    );

    const { rows: [bet] } = await c.query(
      `INSERT INTO bets (user_id, prediction_id, option_idx, amount)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, predId, optIdx, amount]
    );
    return bet;
  });
};

const getOpen = async (matchId) => {
  const { rows } = await query(
    "SELECT * FROM predictions WHERE status='open'" +
    (matchId ? " AND match_id=$1" : "") +
    " ORDER BY created_at DESC LIMIT 20",
    matchId ? [matchId] : []
  );
  return rows;
};

const getResolved = async (matchId, limit = 10) => {
  const { rows } = await query(
    "SELECT * FROM predictions WHERE status='resolved'" +
    (matchId ? " AND match_id=$1 ORDER BY resolved_at DESC LIMIT $2" : " ORDER BY resolved_at DESC LIMIT $1"),
    matchId ? [matchId, limit] : [limit]
  );
  return rows;
};

const getUserHistory = async (userId, limit = 30) => {
  const { rows } = await query(
    `SELECT b.id, b.option_idx, b.amount, b.payout, b.status, b.is_jackpot, b.created_at,
            p.question, p.options, p.winner, p.house_win, p.resolve_mode
     FROM bets b
     JOIN predictions p ON p.id = b.prediction_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

module.exports = {
  createPrediction, resolvePrediction, placeBet,
  getOpen, getResolved, getUserHistory,
};
