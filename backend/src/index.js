require('dotenv').config();
const http      = require('http');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const { initWebSocket } = require('./ws');

const app    = express();
const server = http.createServer(app);

// ── SECURITY
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));

// ── RATE LIMITING
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, intenta en 15 minutos' },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiados intentos, espera 15 minutos' },
});

// ── ROUTES
app.use('/api/auth',        authLimiter, require('./routes/auth.routes'));
app.use('/api/wallet',      require('./routes/wallet.routes'));
app.use('/api/predictions', require('./routes/predictions.routes'));
app.use('/api/admin',       require('./routes/admin.routes'));

// ── HEALTH CHECK
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── ERROR HANDLER (must be last)
app.use(require('./middleware/error.middleware'));

// ── START
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[API] Fanbassy running on port ${PORT}`);
  initWebSocket(server);
});
