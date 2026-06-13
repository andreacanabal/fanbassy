module.exports = (err, req, res, next) => {
  const status = err.status || 500;
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Error interno del servidor'
      : err.message;
  if (status === 500) console.error('[ERROR]', err);
  res.status(status).json({ error: message });
};
