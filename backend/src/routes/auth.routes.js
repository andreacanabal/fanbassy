const router = require('express').Router();
const svc    = require('../services/auth.service');
const { authenticate } = require('../middleware/auth.middleware');

const w = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.post('/register', w(async (req, res) => {
  const result = await svc.register(req.body);
  res.status(201).json(result);
}));

router.post('/login', w(async (req, res) => {
  res.json(await svc.login(req.body));
}));

router.get('/me', authenticate, w(async (req, res) => {
  res.json(await svc.me(req.user.id));
}));

module.exports = router;
