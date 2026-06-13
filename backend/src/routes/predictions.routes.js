const router = require('express').Router();
const svc    = require('../services/prediction.service');
const { authenticate } = require('../middleware/auth.middleware');

const w = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Public
router.get('/open',     w(async (req, res) => res.json(await svc.getOpen(req.query.matchId))));
router.get('/resolved', w(async (req, res) => res.json(await svc.getResolved(req.query.matchId))));

// Authenticated
router.post('/bet', authenticate, w(async (req, res) => {
  const { predId, optIdx, amount } = req.body;
  const bet = await svc.placeBet(req.user.id, predId, parseInt(optIdx), parseFloat(amount));
  res.status(201).json(bet);
}));

router.get('/history', authenticate, w(async (req, res) => {
  res.json(await svc.getUserHistory(req.user.id));
}));

module.exports = router;
