const router = require('express').Router();
const svc    = require('../services/wallet.service');
const { authenticate } = require('../middleware/auth.middleware');

const w = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(authenticate);

router.get('/balance', w(async (req, res) => {
  const data = await svc.getBalance(req.user.id);
  res.json(data);
}));

router.get('/transactions', w(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(await svc.getTransactions(req.user.id, limit));
}));

router.post('/deposit', w(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  res.json(await svc.deposit(req.user.id, amount));
}));

router.post('/withdraw', w(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  const { clabe } = req.body;
  res.json(await svc.withdraw(req.user.id, amount, clabe));
}));

module.exports = router;
