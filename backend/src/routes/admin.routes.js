const router = require('express').Router();
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

const w = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(authenticate, requireAdmin);

router.get('/stats', w(async (req, res) => {
  const [users, volume, sweep, pending, preds] = await Promise.all([
    query('SELECT COUNT(*) AS c FROM users'),
    query("SELECT COALESCE(SUM(ABS(amount)),0) AS v FROM transactions WHERE type='bet'"),
    query("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type LIKE 'sweep%'"),
    query("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS a FROM withdrawals WHERE status='pending'"),
    query('SELECT COUNT(*) AS c FROM predictions'),
  ]);
  res.json({
    users:              +users.rows[0].c,
    totalVolume:        +volume.rows[0].v,
    totalSweep:         +sweep.rows[0].s,
    pendingWithdrawals: +pending.rows[0].c,
    pendingAmount:      +pending.rows[0].a,
    predictions:        +preds.rows[0].c,
  });
}));

router.get('/users', w(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.username, u.role, u.is_active, u.created_at,
            w.balance, w.total_deposited,
            (SELECT COUNT(*) FROM bets WHERE user_id=u.id) AS bets_count
     FROM users u LEFT JOIN wallets w ON w.user_id=u.id
     ORDER BY u.created_at DESC LIMIT 100`
  );
  res.json(rows);
}));

router.get('/withdrawals', w(async (req, res) => {
  const { rows } = await query(
    `SELECT w.*, u.email, u.username
     FROM withdrawals w JOIN users u ON u.id=w.user_id
     WHERE w.status='pending' ORDER BY w.created_at ASC`
  );
  res.json(rows);
}));

router.post('/withdrawals/:id/approve', w(async (req, res) => {
  await query("UPDATE withdrawals SET status='approved', updated_at=NOW() WHERE id=$1", [req.params.id]);
  res.json({ success: true });
}));

router.post('/withdrawals/:id/reject', w(async (req, res) => {
  const { rows: [w] } = await query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
  if (!w) return res.status(404).json({ error: 'No encontrado' });
  await query("UPDATE withdrawals SET status='rejected', updated_at=NOW() WHERE id=$1", [req.params.id]);
  // Refund user
  const walletSvc = require('../services/wallet.service');
  const { withTransaction } = require('../db');
  await withTransaction(async (c) => {
    await walletSvc.addTx(c, { userId:w.user_id, type:'refund', amount:parseFloat(w.amount), description:'Retiro rechazado - fondos devueltos' });
  });
  res.json({ success: true });
}));

router.post('/users/:id/toggle', w(async (req, res) => {
  await query('UPDATE users SET is_active = NOT is_active WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
