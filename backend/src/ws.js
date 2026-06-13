const WebSocket = require('ws');
const { createPrediction, resolvePrediction, getOpen } = require('./services/prediction.service');

const MATCH_ID = 'match_espana_peru_2026';

let wss = null;
let activePred = null;
let timer = null;

const broadcast = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
};

const spawnNext = async () => {
  try {
    activePred = await createPrediction(MATCH_ID);
    broadcast({ type: 'prediction:new', prediction: activePred });
    startCountdown(activePred);
    console.log('[WS] New prediction:', activePred.id, '—', activePred.question);
  } catch (err) {
    console.error('[WS] spawnNext error:', err.message);
    setTimeout(spawnNext, 5000);
  }
};

const startCountdown = (pred) => {
  let timeLeft = pred.duration_sec;
  clearInterval(timer);

  timer = setInterval(async () => {
    timeLeft -= 1;
    broadcast({ type: 'prediction:tick', id: pred.id, timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timer);
      try {
        const result = await resolvePrediction(pred.id);
        broadcast({ type: 'prediction:resolved', ...result });
        console.log('[WS] Resolved:', pred.id, '—', result.mode);

        // Wait 3s then spawn new prediction
        setTimeout(spawnNext, 3000);
      } catch (err) {
        console.error('[WS] resolve error:', err.message);
        setTimeout(spawnNext, 3000);
      }
    }
  }, 1000);
};

const initWebSocket = (server) => {
  wss = new WebSocket.Server({ server });

  wss.on('connection', async (ws) => {
    console.log('[WS] Client connected, total:', wss.clients.size);

    // Send current open prediction state immediately on connect
    const open = await getOpen(MATCH_ID).catch(() => []);
    ws.send(JSON.stringify({ type: 'predictions:init', predictions: open }));

    ws.on('close', () => {
      console.log('[WS] Client disconnected, total:', wss.clients.size);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  // Start the prediction engine
  spawnNext();

  console.log('[WS] WebSocket engine started');
  return wss;
};

module.exports = { initWebSocket, broadcast };
