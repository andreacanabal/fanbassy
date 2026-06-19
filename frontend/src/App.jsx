
import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { api, setToken, getToken, clearToken, wsConnect, wsDisconnect } from "./api.js";

// ── DB
const DB = {
  users: new Map(), sessions: new Map(), wallets: new Map(),
  transactions: new Map(), predictions: new Map(), bets: new Map(),
  withdrawals: new Map(), affiliates: new Map(), referrals: new Map(),
};
let _id = 1;
const genId = () => "id_" + (_id++) + "_" + Date.now();
const genToken = () => "tok_" + Math.random().toString(36).slice(2) + "_" + Date.now();

const seedDB = () => {
  const aId = "user_admin", dId = "user_demo";
  DB.users.set(aId, { id:aId, email:"admin@fanbassy.com", username:"Admin", passwordHash:"hashed_admin123", role:"admin", isActive:true });
  DB.users.set(dId,  { id:dId, email:"demo@fanbassy.com",  username:"DemoUser", passwordHash:"hashed_demo123",  role:"user",  isActive:true });
  DB.wallets.set(aId, { userId:aId, balance:500, totalDeposited:500, totalWithdrawn:0, totalWon:0, totalLost:0 });
  DB.wallets.set(dId,  { userId:dId, balance:25,  totalDeposited:25,  totalWithdrawn:0, totalWon:0, totalLost:0 });
  DB.affiliates.set(aId, { userId:aId, code:"ADMIN2026", level:2, commissionPct:0.30, totalEarned:48.5, totalReferrals:12, isActive:true });
  DB.affiliates.set(dId,  { userId:dId, code:"DEMO2026",  level:1, commissionPct:0.20, totalEarned:8.4,  totalReferrals:3,  isActive:true });
  [
    { userId:dId, type:"deposit", amount:25,  desc:"Deposito inicial" },
    { userId:dId, type:"bet",     amount:-2,  desc:"Apuesta" },
    { userId:dId, type:"win",     amount:3.8, desc:"Ganancia" },
  ].forEach(tx => {
    const id = genId();
    DB.transactions.set(id, { id, ...tx, balanceBefore:0, balanceAfter:0, createdAt:Date.now()-Math.random()*86400000 });
  });
};
seedDB();

// ── PRED TYPES
const PRED_TYPE = { STANDARD:"A", TRIPLE:"B", JACKPOT:"C" };

const JACKPOT_EVENTS = [
  { question:"JACKPOT - Gol en los proximos 60 segundos?", multiplier:8,  dur:60 },
  { question:"JACKPOT - Penalti en los proximos 45 segundos?", multiplier:10, dur:45 },
  { question:"JACKPOT - Tarjeta ROJA en los proximos 60 segundos?", multiplier:12, dur:60 },
];

const TEMPLATES = [
  { type:PRED_TYPE.STANDARD, question:"Quien tiene el siguiente tiro de esquina?", options:["🇪🇸 Espana","🇵🇪 Peru"], dur:25, nullLabel:"Revision VAR" },
  { type:PRED_TYPE.STANDARD, question:"Habra falta en los proximos 3 minutos?",    options:["Si","No"],           dur:30, nullLabel:"Lesion" },
  { type:PRED_TYPE.STANDARD, question:"Quien gana el siguiente duelo aereo?", options:["🇪🇸 Espana","🇵🇪 Peru"], dur:20, nullLabel:"Tiempo medico" },
  { type:PRED_TYPE.STANDARD, question:"Habra sustitucion antes del min 75?",        options:["Si","No"],           dur:35, nullLabel:"Revision VAR" },
  { type:PRED_TYPE.STANDARD, question:"Proximo tiro al arco?", options:["🇪🇸 Espana","🇵🇪 Peru"], dur:28, nullLabel:"Lesion" },
  { type:PRED_TYPE.STANDARD, question:"Habra tarjeta en los proximos 5 min?",       options:["Si","No"],           dur:32, nullLabel:"Revision VAR" },
  { type:PRED_TYPE.TRIPLE,   question:"Que pasa en el siguiente corner?",            options:["Despejan","Tiro al arco","Gol directo"], dur:30, tripleIdx:2, tripleLabel:"Gol directo" },
  { type:PRED_TYPE.TRIPLE,   question:"Resultado del siguiente tiro libre?",         options:["Bloqueado","Fuera","Gol directo"],        dur:28, tripleIdx:2, tripleLabel:"Gol directo" },
];

// ── WALLET SVC
const WalletSvc = {
  get: uid => DB.wallets.get(uid),
  addTx: (uid, type, amount, desc) => {
    const w = DB.wallets.get(uid);
    if (!w) return;
    const bal = w.balance + amount;
    DB.wallets.set(uid, { ...w, balance:bal });
    const id = genId();
    DB.transactions.set(id, { id, userId:uid, type, amount, balanceBefore:w.balance, balanceAfter:bal, desc, createdAt:Date.now() });
  },
  deposit: (uid, amount) => {
    if (amount < 1) return { error:"Minimo $1" };
    WalletSvc.addTx(uid, "deposit", amount, "Deposito");
    const user = DB.users.get(uid);
    if (user && user.referredBy) {
      const aff = DB.affiliates.get(user.referredBy);
      if (aff && aff.isActive) {
        const comm = amount * 0.05 * aff.commissionPct;
        WalletSvc.addTx(aff.userId, "affiliate", comm, "Comision afiliado");
        DB.affiliates.set(aff.userId, { ...aff, totalEarned: aff.totalEarned + comm });
      }
    }
    return { success:true };
  },
  withdraw: (uid, amount, clabe) => {
    const w = DB.wallets.get(uid);
    if (!w) return { error:"No encontrado" };
    if (amount < 5) return { error:"Minimo $5" };
    if (w.balance < amount) return { error:"Saldo insuficiente" };
    if (!clabe || clabe.length !== 18) return { error:"CLABE invalida (18 digitos)" };
    WalletSvc.addTx(uid, "withdrawal", -amount, "Retiro SPEI");
    const wId = genId();
    DB.withdrawals.set(wId, { id:wId, userId:uid, amount, clabe, status:"pending", createdAt:Date.now() });
    return { success:true };
  },
  getTxs: uid => {
    const all = [];
    DB.transactions.forEach(t => { if (t.userId === uid) all.push(t); });
    return all.sort((a,b) => b.createdAt - a.createdAt).slice(0,50);
  },
};

// ── AUTH SVC
const AuthSvc = {
  login: (email, pw) => {
    let user = null;
    DB.users.forEach(u => { if (u.email === email) user = u; });
    if (!user || !user.isActive) return { error:"Credenciales invalidas" };
    if (user.passwordHash !== ("hashed_" + pw)) return { error:"Credenciales invalidas" };
    const token = genToken();
    DB.sessions.set(token, { userId:user.id, expiresAt:Date.now() + 7*86400000 });
    return { user:{ id:user.id, email:user.email, username:user.username, role:user.role }, token };
  },
  register: (email, username, pw, refCode) => {
    if (!email.includes("@")) return { error:"Email invalido" };
    if (pw.length < 6) return { error:"Password minimo 6 caracteres" };
    if (username.length < 3) return { error:"Usuario minimo 3 caracteres" };
    let exists = false;
    DB.users.forEach(u => { if (u.email === email) exists = true; });
    if (exists) return { error:"Email ya registrado" };
    let referredBy = null;
    if (refCode) {
      DB.affiliates.forEach(a => { if (a.code === refCode.toUpperCase() && a.isActive) referredBy = a.userId; });
    }
    const id = genId();
    DB.users.set(id, { id, email, username, passwordHash:"hashed_"+pw, role:"user", isActive:true, referredBy, createdAt:Date.now() });
    DB.wallets.set(id, { userId:id, balance:0, totalDeposited:0, totalWithdrawn:0, totalWon:0, totalLost:0 });
    const code = username.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5) + Math.random().toString(36).slice(2,5).toUpperCase();
    DB.affiliates.set(id, { userId:id, code, level:1, commissionPct:0.20, totalEarned:0, totalReferrals:0, isActive:true });
    const token = genToken();
    DB.sessions.set(token, { userId:id, expiresAt:Date.now() + 7*86400000 });
    return { user:{ id, email, username, role:"user" }, token };
  },
};

// ── PRED ENGINE
let predCount = 0;
const PredEng = {
  COMMISSION: 0.05,
  create: (matchId, tmplIdx) => {
    predCount++;
    let t;
    if (predCount % 8 === 0) {
      const jp = JACKPOT_EVENTS[Math.floor(Math.random() * JACKPOT_EVENTS.length)];
      t = { type:PRED_TYPE.JACKPOT, question:jp.question, options:["Si ocurre","No ocurre"], dur:jp.dur, multiplier:jp.multiplier };
    } else {
      t = TEMPLATES[tmplIdx % TEMPLATES.length];
    }
    const votes = t.options.map((_, i) => {
      if (t.type === PRED_TYPE.TRIPLE && i === t.tripleIdx) return Math.floor(Math.random()*8)+2;
      if (t.type === PRED_TYPE.JACKPOT && i === 0) return Math.floor(Math.random()*12)+3;
      return Math.floor(Math.random()*200)+50;
    });
    const pools = votes.map(v => v * 1.0);
    const id = genId();
    const pred = {
      id, matchId,
      type: t.type || PRED_TYPE.STANDARD,
      question:t.question, options:t.options,
      status:"open", timeLeft:t.dur, durationSec:t.dur,
      votes, pools, totalPool:pools.reduce((a,b)=>a+b,0),
      winner:null, houseWin:false, houseSweepAmount:0, resolveMode:"normal",
      nullLabel:t.nullLabel||null, tripleIdx:t.tripleIdx!=null?t.tripleIdx:null,
      tripleLabel:t.tripleLabel||null, multiplier:t.multiplier||null,
    };
    DB.predictions.set(id, pred);
    return pred;
  },
  placeBet: (userId, predId, optIdx, amount) => {
    const pred = DB.predictions.get(predId);
    if (!pred || pred.status !== "open") return { error:"Prediccion no disponible" };
    let alreadyBet = false;
    DB.bets.forEach(b => { if (b.userId===userId && b.predictionId===predId) alreadyBet=true; });
    if (alreadyBet) return { error:"Ya apostaste en esta prediccion" };
    const w = DB.wallets.get(userId);
    if (!w || w.balance < amount) return { error:"Saldo insuficiente" };
    WalletSvc.addTx(userId, "bet", -amount, "Apuesta colocada");
    const betId = genId();
    DB.bets.set(betId, { id:betId, userId, predictionId:predId, optionIdx:optIdx, amount, payout:0, status:"pending" });
    const nv = [...pred.votes]; nv[optIdx] += 1;
    const np = [...pred.pools]; np[optIdx] += amount;
    DB.predictions.set(predId, { ...pred, votes:nv, pools:np, totalPool:pred.totalPool+amount });
    return { success:true, betId };
  },
  resolve: (predId, winnerIdx) => {
    const pred = DB.predictions.get(predId);
    if (!pred) return;
    const bets = [];
    DB.bets.forEach(b => { if (b.predictionId===predId) bets.push(b); });
    const nullFired   = pred.type===PRED_TYPE.STANDARD && Math.random()<0.06;
    const tripleFired = pred.type===PRED_TYPE.TRIPLE && pred.tripleIdx!=null && winnerIdx===pred.tripleIdx;
    const jackpotFired= pred.type===PRED_TYPE.JACKPOT && Math.random()<0.04;
    let mode="normal", houseWin=false, houseSweep=0, resolvedWinner=winnerIdx;
    if (nullFired) {
      mode="null_event"; houseWin=true; houseSweep=pred.totalPool; resolvedWinner=-1;
      WalletSvc.addTx("wallet_house","sweep_null",pred.totalPool,"Evento nulo");
      bets.forEach(b => DB.bets.set(b.id,{...b,status:"lost",houseWin:true}));
    } else if (tripleFired) {
      mode="triple_c"; houseWin=true; houseSweep=pred.totalPool; resolvedWinner=pred.tripleIdx;
      WalletSvc.addTx("wallet_house","sweep_triple",pred.totalPool,"Triple resultado");
      bets.forEach(b => DB.bets.set(b.id,{...b,status:"lost",houseWin:true}));
    } else if (jackpotFired) {
      mode="jackpot_hit"; houseWin=true; resolvedWinner=0;
      houseSweep = pred.totalPool*0.5;
      WalletSvc.addTx("wallet_house","sweep_jackpot",houseSweep,"Jackpot");
      const jpBets = bets.filter(b=>b.optionIdx===0);
      const jpPool = jpBets.reduce((s,b)=>s+b.amount,0);
      const winnersShare = pred.totalPool*0.5;
      jpBets.forEach(bet => {
        const payout = jpPool>0 ? (bet.amount/jpPool)*winnersShare : 0;
        DB.bets.set(bet.id,{...bet,payout,status:"won",jackpot:true});
        if (payout>0) WalletSvc.addTx(bet.userId,"win",payout,"JACKPOT ACTIVADO");
      });
      bets.filter(b=>b.optionIdx!==0).forEach(b=>DB.bets.set(b.id,{...b,status:"lost"}));
    } else {
      const wPool=pred.pools[winnerIdx]||0, lPool=pred.totalPool-wPool;
      bets.forEach(bet=>{
        if (bet.optionIdx===winnerIdx && wPool>0) {
          const payout = bet.amount + (lPool*(bet.amount/wPool))*(1-PredEng.COMMISSION);
          DB.bets.set(bet.id,{...bet,payout,status:"won"});
          WalletSvc.addTx(bet.userId,"win",payout,"Ganaste prediccion");
        } else {
          DB.bets.set(bet.id,{...bet,status:"lost"});
        }
      });
    }
    DB.predictions.set(predId, {...pred,status:"resolved",winner:resolvedWinner,houseWin,houseSweepAmount:houseSweep,resolveMode:mode,resolvedAt:Date.now()});
  },
  getUserBet: (userId, predId) => {
    let found = null;
    DB.bets.forEach(b=>{ if(b.userId===userId&&b.predictionId===predId) found=b; });
    return found;
  },
  getUserHistory: userId => {
    const hist = [];
    DB.bets.forEach(b=>{
      if (b.userId===userId) hist.push({...b, prediction:DB.predictions.get(b.predictionId)});
    });
    return hist.sort((a,b)=>b.createdAt-a.createdAt).slice(0,30);
  },
};

// ── AFFILIATE SVC
const AffSvc = {
  get: uid => DB.affiliates.get(uid),
  toggle: uid => { const a=DB.affiliates.get(uid); if(a) DB.affiliates.set(uid,{...a,isActive:!a.isActive}); },
  promote: uid => { const a=DB.affiliates.get(uid); if(a) DB.affiliates.set(uid,{...a,level:2,commissionPct:0.30}); },
};

// ── SPORTS DATA
const SPORTS_DATA = [
  { id:"futbol", nameEs:"Futbol", nameEn:"Soccer", color:"#00E87A",
    leagues:["Mundial 2026","Liga MX","Champions League"],
    matches:[
      { id:"m1", home:"🇪🇸 Espana", away:"🇵🇪 Peru", scoreH:3, scoreA:1, minute:"53", preds:12, league:"Amistosos" },
      { id:"m2", home:"Brasil",  away:"Francia",   scoreH:0, scoreA:2, minute:"34", preds:5, league:"Mundial 2026" },
      { id:"m3", home:"America", away:"Chivas",    scoreH:2, scoreA:1, minute:"78", preds:6, league:"Liga MX" },
    ]
  },
  { id:"basketball", nameEs:"Baloncesto", nameEn:"Basketball", color:"#FF7A00",
    leagues:["NBA"],
    matches:[ { id:"m5", home:"Lakers", away:"Celtics", scoreH:88, scoreA:92, minute:"Q3", preds:4, league:"NBA" } ]
  },
  { id:"nfl", nameEs:"Fut Americano", nameEn:"American Football", color:"#00C8FF",
    leagues:["NFL"],
    matches:[ { id:"m7", home:"Chiefs", away:"49ers", scoreH:14, scoreA:10, minute:"Q2", preds:5, league:"NFL" } ]
  },
];

// ── TRANSLATIONS
const T = {
  es: { appName:"FANBASSY", liveNow:"EN VIVO", signIn:"Iniciar sesion", signUp:"Registrarse", signUpFree:"Registrarse gratis", balance:"Saldo", depositWithdraw:"Depositar / Retirar", leaderboard:"Tabla de clasificacion", leaderboardSub:"Los mejores predictores", affiliates:"Afiliados", affiliatesSub:"Gana comision por referidos", language:"Idioma", terms:"Terminos y condiciones", help:"Centro de ayuda", logout:"Cerrar sesion", navHome:"Inicio", navLive:"En vivo", navSearch:"Buscar", navMore:"Mas", tabOpen:"En curso", tabResolved:"Resueltas", tabHistory:"Historial", pool:"Premio acumulado", votes:"participantes", yourBet:"Tu apuesta", won:"Ganaste", lost:"Perdiste", winnerWas:"Ganador", pending:"En curso", waitingEvent:"Esperando el proximo evento...", noResolved:"Sin predicciones resueltas", noHistory:"Aun no has apostado", guestTitle:"Listo para ganar?", guestSub:"Crea tu cuenta gratis.", guestCta:"Crear cuenta gratis", guestLogin:"Ya tienes cuenta? Inicia sesion", guestBenefit1:"Deposito minimo $1 USD", guestBenefit2:"Retiros a tu banco", guestBenefit3:"Sin comision de entrada", guestBenefit4:"Predicciones cada 30 segundos", nudgeTitle:"Apuesta en esta prediccion", nudgeSub:"Crea tu cuenta en 30 segundos", nudgeCta:"Crear cuenta", wonLabel:"Ganadas", lostLabel:"Perdidas", earnedLabel:"Ganancias", winRate:"Acierto", quickHistory:"Ultimos movimientos", confirmBet:"Confirmar apuesta", cancel:"Cancelar", estimatedWin:"Ganancia estimada", commissionNote:"Incluye apuesta - 5% comision", allSports:"Todos", live:"EN VIVO", predictions:"predicciones", worldCup:"Amistosos Internacionales", stadium:"Valencia, Espana", activePreds:"predicciones activas" },
  en: { appName:"FANBASSY", liveNow:"LIVE", signIn:"Sign in", signUp:"Sign up", signUpFree:"Sign up free", balance:"Balance", depositWithdraw:"Deposit / Withdraw", leaderboard:"Leaderboard", leaderboardSub:"Top predictors", affiliates:"Affiliates", affiliatesSub:"Earn commission on referrals", language:"Language", terms:"Terms & conditions", help:"Help center", logout:"Log out", navHome:"Home", navLive:"Live", navSearch:"Search", navMore:"More", tabOpen:"Live", tabResolved:"Resolved", tabHistory:"History", pool:"Prize pool", votes:"participants", yourBet:"Your bet", won:"You won", lost:"You lost", winnerWas:"Winner", pending:"Pending", waitingEvent:"Waiting for next event...", noResolved:"No resolved predictions yet", noHistory:"No bets yet", guestTitle:"Ready to win?", guestSub:"Create your free account.", guestCta:"Create free account", guestLogin:"Already have an account? Sign in", guestBenefit1:"Minimum deposit $1 USD", guestBenefit2:"Withdraw to your bank", guestBenefit3:"No entry commission", guestBenefit4:"Predictions every 30 seconds", nudgeTitle:"Bet on this prediction", nudgeSub:"Create your account in 30 seconds", nudgeCta:"Create account", wonLabel:"Won", lostLabel:"Lost", earnedLabel:"Earnings", winRate:"Accuracy", quickHistory:"Recent activity", confirmBet:"Confirm bet", cancel:"Cancel", estimatedWin:"Estimated payout", commissionNote:"Includes stake - 5% commission", allSports:"All", live:"LIVE", predictions:"predictions", worldCup:"International Friendly", stadium:"Valencia, Spain", activePreds:"active predictions" },
};

const fmtTime = ts => new Date(ts).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"});
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── CONTEXTS
const AuthCtx   = createContext(null);
const WalletCtx = createContext(null);
const ToastCtx  = createContext(null);
const useAuth   = () => useContext(AuthCtx);
const useWallet = () => useContext(WalletCtx);
const useToast  = () => useContext(ToastCtx);

// ── CSS
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;700&family=Unbounded:wght@400;600;800&display=swap');
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes shUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes fdIn{from{opacity:0}to{opacity:1}}
@keyframes toIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
@keyframes toOut{from{opacity:1}to{opacity:0}}
@keyframes scanline{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 8px 1px rgba(255,51,82,.3)}50%{box-shadow:0 0 14px 3px rgba(255,51,82,.5)}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#06080D;--s1:#0C0F18;--s2:#11151F;--s3:#161B28;--border:rgba(255,255,255,.06);--border2:rgba(255,255,255,.11);--green:#00E87A;--red:#FF3352;--yellow:#FFB800;--blue:#00C8FF;--text:#EDF2F7;--muted:#4A5568;--muted2:#718096;--fa:'Bebas Neue',sans-serif;--fd:'Unbounded',sans-serif;--fm:'JetBrains Mono',monospace}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--fd);-webkit-font-smoothing:antialiased}
button{cursor:pointer;border:none;background:none;font-family:var(--fd);color:inherit}
input{font-family:var(--fd);outline:none}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
.app{height:100vh;max-height:100vh;overflow-y:auto;overflow-x:hidden;background:var(--bg);background-image:radial-gradient(ellipse 60% 40% at 50% 0%,rgba(0,232,122,.05) 0%,transparent 70%);padding-bottom:76px}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);background:rgba(6,8,13,.95);backdrop-filter:blur(24px);position:sticky;top:0;z-index:100;gap:8px}
.logo{font-family:var(--fa);font-size:22px;letter-spacing:3px;background:linear-gradient(135deg,var(--green),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent;flex-shrink:0}
.hdr-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.live-pill{display:flex;align-items:center;gap:4px;background:rgba(255,51,82,.12);border:1px solid rgba(255,51,82,.3);padding:4px 8px;border-radius:20px;font-size:9px;font-weight:700;color:var(--red);letter-spacing:1px;white-space:nowrap;flex-shrink:0}
.live-dot{width:5px;height:5px;background:var(--red);border-radius:50%;animation:blink 1.1s infinite;flex-shrink:0}
.bal-chip{display:flex;flex-direction:column;align-items:flex-end;background:var(--s2);border:1px solid var(--border2);padding:5px 10px;border-radius:10px;cursor:pointer;transition:border-color .2s;flex-shrink:0}
.bal-chip:hover{border-color:var(--green)}
.bal-amt{font-family:var(--fm);font-size:13px;color:var(--green);font-weight:700}
.bal-lbl{font-size:8px;color:var(--muted2);letter-spacing:1px;text-transform:uppercase}
.hdr-signin{background:transparent;border:1px solid var(--border2);border-radius:8px;padding:7px 11px;font-size:11px;font-weight:600;color:var(--muted2);white-space:nowrap;flex-shrink:0;transition:all .2s}
@media(max-width:480px){.hdr-signin{display:none}}
.hdr-signup{background:linear-gradient(135deg,var(--green),var(--blue));border:none;border-radius:8px;padding:8px 13px;font-size:11px;font-weight:800;color:#06080D;cursor:pointer;white-space:nowrap;flex-shrink:0}
.match-wrap{padding:10px 16px 0}
.match-card{background:var(--s1);border:1px solid var(--border);border-radius:14px;overflow:hidden;position:relative}
.match-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--red) 40%,var(--red) 60%,transparent);animation:scanline 2.5s ease-in-out infinite}
.match-hdr{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border);font-family:var(--fm);font-size:9px;color:var(--muted2);gap:8px}
.match-body{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:14px 16px;gap:8px}
.team-info{display:flex;flex-direction:column;gap:3px}
.team-info.away{align-items:flex-end}
.team-flag{font-size:28px;line-height:1}
.team-name{font-family:var(--fa);font-size:16px;letter-spacing:2px}
.scorebox{display:flex;flex-direction:column;align-items:center;gap:4px}
.score-txt{font-family:var(--fa);font-size:42px;letter-spacing:6px;color:#fff;line-height:1}
.min-badge{background:rgba(255,51,82,.18);border:1px solid rgba(255,51,82,.35);color:#FF6B6B;font-family:var(--fm);font-size:10px;padding:2px 8px;border-radius:20px}
.main-grid{display:grid;grid-template-columns:1fr 280px;gap:12px;padding:12px 16px;max-width:1080px;margin:0 auto}
@media(max-width:760px){.main-grid{grid-template-columns:1fr;padding:10px 16px}.sidebar{display:none}}
.nav-tabs{display:flex;gap:2px;background:var(--s2);border-radius:10px;padding:3px;margin:12px 16px 0}
.nav-tab{flex:1;padding:8px 10px;border-radius:8px;font-size:10px;font-weight:600;letter-spacing:.3px;transition:all .2s;color:var(--muted2);text-align:center}
.nav-tab.active{background:var(--s1);color:var(--text);box-shadow:0 1px 6px rgba(0,0,0,.5)}
.sec-hdr{font-family:var(--fm);font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted2);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.sec-hdr::after{content:'';flex:1;height:1px;background:var(--border)}
.pred-list{display:flex;flex-direction:column;gap:10px;min-height:120px}
.pred-card{background:var(--s1);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:border-color .3s;position:relative}
.pred-card.open{border-color:rgba(0,232,122,.12)}
.pred-card.voted{border-color:rgba(0,200,255,.2)}
.pred-card.resolved{opacity:.65}
.pred-card.jackpot{border-color:rgba(255,51,82,.25);background:linear-gradient(135deg,var(--s1),rgba(255,51,82,.04));animation:pulseGlow 3s ease-in-out infinite}
.pred-type-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-family:var(--fm);font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:8px 14px 0;width:fit-content}
.pred-type-badge.standard{background:rgba(0,232,122,.08);color:var(--green);border:1px solid rgba(0,232,122,.2)}
.pred-type-badge.triple{background:rgba(255,184,0,.08);color:var(--yellow);border:1px solid rgba(255,184,0,.2)}
.pred-type-badge.jackpot{background:rgba(255,51,82,.1);color:var(--red);border:1px solid rgba(255,51,82,.3)}
.pred-top{display:flex;align-items:flex-start;justify-content:space-between;padding:8px 14px;gap:10px}
.pred-q{font-size:13px;font-weight:600;line-height:1.35;flex:1}
.timer-box{display:flex;flex-direction:column;align-items:center;min-width:38px}
.timer-n{font-family:var(--fa);font-size:24px;line-height:1;color:var(--green);transition:color .3s}
.timer-n.hot{color:var(--red)}
.timer-l{font-size:8px;color:var(--muted);letter-spacing:1px;text-transform:uppercase}
.pred-meta{padding:0 14px 8px;font-family:var(--fm);font-size:11px;color:var(--muted2);display:flex;gap:6px;flex-wrap:wrap}
.pool-val{color:var(--yellow);font-weight:500}
.pred-notice{font-family:var(--fm);font-size:9px;color:var(--muted);padding:0 14px 6px;letter-spacing:.5px}
.opts-grid{display:grid;gap:7px;padding:0 10px 10px}
.opt-btn{display:flex;flex-direction:column;gap:5px;background:var(--s2);border:1px solid var(--border);border-radius:9px;padding:9px 11px;cursor:pointer;transition:all .18s;text-align:left}
.opt-btn:hover:not(:disabled){border-color:var(--green);background:rgba(0,232,122,.04);transform:translateY(-1px)}
.opt-btn.sel{border-color:var(--blue);background:rgba(0,200,255,.07)}
.opt-btn.win{border-color:var(--green);background:rgba(0,232,122,.07)}
.opt-btn.lose{opacity:.45}
.opt-btn:disabled{cursor:default}
.opt-top{display:flex;justify-content:space-between;align-items:center}
.opt-lbl{font-size:13px;font-weight:600}
.opt-pct{font-family:var(--fm);font-size:12px;color:var(--muted2)}
.bar-track{height:2px;background:var(--border);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--blue));border-radius:2px;transition:width .5s ease}
.opt-sub{font-family:var(--fm);font-size:10px;color:var(--muted)}
.resolved-tag{display:flex;align-items:center;gap:6px;padding:7px 12px;margin:0 10px 10px;border-radius:7px;font-size:11px;font-weight:600}
.resolved-tag.win{background:rgba(0,232,122,.07);border:1px solid rgba(0,232,122,.2);color:var(--green)}
.resolved-tag.lose{background:rgba(255,51,82,.07);border:1px solid rgba(255,51,82,.2);color:var(--red)}
.resolved-tag.neutral{background:var(--s2);border:1px solid var(--border);color:var(--muted2)}
.house-win-tag{display:flex;align-items:center;gap:6px;padding:7px 12px;margin:0 10px 10px;border-radius:7px;font-size:11px;font-weight:600;background:rgba(255,184,0,.07);border:1px solid rgba(255,184,0,.2);color:var(--yellow)}
.empty-state{text-align:center;padding:32px 20px;color:var(--muted);font-size:12px}
.card{background:var(--s1);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px}
.bal-big{font-family:var(--fa);font-size:38px;letter-spacing:2px;color:var(--green);line-height:1;margin:6px 0 3px}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px}
.stat-item{background:var(--s2);border-radius:8px;padding:9px 11px}
.stat-v{font-family:var(--fm);font-size:15px;font-weight:700}
.stat-v.g{color:var(--green)}.stat-v.r{color:var(--red)}
.stat-l{font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-top:2px}
.dep-btn{width:100%;background:var(--s2);border:1px solid var(--border2);border-radius:9px;padding:10px;font-size:12px;font-weight:700;color:var(--text);margin-top:10px;transition:all .2s}
.dep-btn:hover{border-color:var(--green);color:var(--green)}
.history-list{display:flex;flex-direction:column;max-height:280px;overflow-y:auto}
.hist-item{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}
.hist-item:last-child{border-bottom:none}
.hist-q{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
.hist-meta{font-family:var(--fm);font-size:10px;color:var(--muted2)}
.hist-res{font-family:var(--fm);font-size:12px;font-weight:700}
.hist-res.w{color:var(--green)}.hist-res.l{color:var(--red)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(10px);display:flex;align-items:flex-end;justify-content:center;z-index:200;animation:fdIn .2s ease}
.sheet{background:var(--s1);border:1px solid var(--border2);border-radius:18px 18px 0 0;padding:22px;width:100%;max-width:460px;animation:shUp .28s cubic-bezier(.16,1,.3,1)}
.handle{width:32px;height:3px;background:var(--border2);border-radius:2px;margin:0 auto 18px}
.sheet-lbl{font-size:11px;color:var(--muted2);margin-bottom:3px;font-family:var(--fm)}
.sheet-q{font-size:16px;font-weight:700;margin-bottom:3px}
.sheet-opt{font-size:13px;color:var(--blue);font-weight:700;margin-bottom:18px}
.presets{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:10px}
.preset{background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:var(--fm);font-size:14px;text-align:center;transition:all .15s}
.preset:hover,.preset.on{border-color:var(--green);color:var(--green);background:rgba(0,232,122,.05)}
.amt-input{width:100%;background:var(--s2);border:1px solid var(--border2);border-radius:9px;padding:11px 14px;font-family:var(--fm);font-size:17px;color:var(--text);margin-bottom:13px;transition:border-color .2s}
.amt-input:focus{border-color:var(--green)}
.payout-row{background:rgba(0,232,122,.04);border:1px solid rgba(0,232,122,.12);border-radius:9px;padding:11px 14px;margin-bottom:13px;display:flex;justify-content:space-between;align-items:center}
.payout-lbl{font-size:11px;color:var(--muted2)}
.payout-sub{font-size:9px;color:var(--muted);margin-top:2px}
.payout-val{font-family:var(--fm);font-size:17px;color:var(--green);font-weight:700}
.confirm-btn{width:100%;background:linear-gradient(135deg,var(--green),var(--blue));border:none;border-radius:11px;padding:14px;font-size:15px;font-weight:800;color:#06080D;letter-spacing:.5px;transition:all .2s}
.confirm-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,232,122,.25)}
.confirm-btn:disabled{opacity:.35;transform:none}
.cancel-btn{width:100%;background:transparent;border:1px solid var(--border);border-radius:10px;padding:12px;font-size:13px;color:var(--muted2);margin-top:7px;transition:all .2s}
.cancel-btn:hover{border-color:var(--border2);color:var(--text)}
.modal-wrap{position:fixed;inset:0;background:rgba(0,0,0,.8);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px;animation:fdIn .2s ease}
.modal{background:var(--s1);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:400px}
.modal-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.modal-title{font-size:18px;font-weight:800}
.close-btn{font-size:18px;color:var(--muted2);transition:color .2s;padding:2px 4px}
.close-btn:hover{color:var(--text)}
.modal-tabs{display:flex;gap:3px;background:var(--s2);border-radius:9px;padding:3px;margin-bottom:16px}
.modal-tab{flex:1;padding:8px;border-radius:6px;font-size:12px;font-weight:600;text-align:center;color:var(--muted2);transition:all .15s}
.modal-tab.active{background:var(--s1);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.4)}
.tx-list{max-height:340px;overflow-y:auto}
.tx-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}
.tx-row:last-child{border-bottom:none}
.tx-tag{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 7px;border-radius:4px;margin-right:6px}
.tx-tag.deposit{background:rgba(0,232,122,.1);color:var(--green)}
.tx-tag.win{background:rgba(0,200,255,.1);color:var(--blue)}
.tx-tag.bet{background:rgba(255,184,0,.1);color:var(--yellow)}
.tx-tag.withdrawal{background:rgba(255,51,82,.1);color:var(--red)}
.tx-tag.affiliate{background:rgba(192,132,252,.15);color:#C084FC}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.field label{font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.8px;font-family:var(--fm)}
.field input{border:1.5px solid var(--border2);border-radius:9px;padding:10px 12px;font-size:14px;color:var(--text);background:var(--s2);transition:border-color .2s}
.field input:focus{border-color:var(--green)}
.auth-bg{min-height:100vh;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px}
.auth-card{background:var(--s1);border:1px solid var(--border2);border-radius:16px;padding:28px;width:100%;max-width:400px}
.auth-logo{font-family:var(--fa);font-size:28px;letter-spacing:5px;background:linear-gradient(135deg,var(--green),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px}
.auth-sub{text-align:center;font-size:11px;color:var(--muted2);letter-spacing:1px;margin-bottom:20px}
.auth-segs{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--s2);border-radius:9px;padding:3px;margin-bottom:20px}
.auth-seg{padding:9px;border-radius:7px;font-size:12px;font-weight:700;text-align:center;color:var(--muted2);transition:all .2s}
.auth-seg.active{background:var(--s1);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.4)}
.err-msg{background:rgba(255,51,82,.08);border:1px solid rgba(255,51,82,.2);color:var(--red);padding:9px 12px;border-radius:8px;font-size:12px;margin-bottom:10px;font-weight:500}
.demo-row{margin-top:14px;padding-top:14px;border-top:1px solid var(--border);text-align:center}
.demo-hint{font-size:11px;color:var(--muted2);line-height:1.6}
.quick-btn{margin-top:8px;background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:7px 16px;font-size:11px;font-weight:700;color:var(--muted2);transition:all .2s}
.quick-btn:hover{border-color:var(--blue);color:var(--blue)}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;background:rgba(8,10,15,.96);border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(4,1fr);z-index:90;backdrop-filter:blur(20px)}
.bn-item{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0;color:var(--muted2);transition:color .2s;font-size:10px;font-weight:600;background:none;border:none;cursor:pointer}
.bn-item svg{width:20px;height:20px}
.bn-item.active{color:var(--green)}
.bn-item.live-indicator{position:relative}
.bn-item.live-indicator::after{content:'';position:absolute;top:8px;right:calc(50% - 14px);width:6px;height:6px;background:var(--red);border-radius:50%;animation:blink 1.1s infinite}
.more-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:300}
.more-sheet{position:fixed;bottom:0;left:0;right:0;background:var(--s1);border-radius:20px 20px 0 0;z-index:301;max-height:85vh;overflow-y:auto;padding-bottom:20px;animation:shUp .28s cubic-bezier(.16,1,.3,1)}
.more-handle{width:36px;height:4px;background:var(--border2);border-radius:2px;margin:14px auto 10px}
.more-section{padding:4px 20px}
.more-section-label{font-family:var(--fm);font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;padding:8px 0 2px}
.more-item{width:100%;display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);background:none;border-top:none;border-left:none;border-right:none;transition:opacity .2s;cursor:pointer}
.more-item:last-child{border-bottom:none}
.more-item:hover{opacity:.75}
.more-item-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.more-item-icon svg{width:18px;height:18px}
.more-item-text{flex:1;text-align:left}
.more-item-title{font-size:14px;font-weight:600}
.more-item-sub{font-size:11px;color:var(--muted2);margin-top:2px}
.more-item-right{color:var(--muted);width:16px;height:16px}
.more-divider{height:1px;background:var(--border);margin:4px 0}
.lang-btn{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:700;background:var(--s2);border:1px solid var(--border);color:var(--muted2);transition:all .2s;margin-right:6px}
.lang-btn.active{border-color:var(--green);color:var(--green);background:rgba(0,232,122,.06)}
.league-row{display:flex;gap:5px;overflow-x:auto;padding:8px 16px;border-bottom:1px solid var(--border)}
.league-chip{padding:5px 12px;border-radius:20px;font-size:11px;font-weight:600;background:var(--s2);border:1px solid var(--border);color:var(--muted2);white-space:nowrap;transition:all .2s;cursor:pointer}
.league-chip.active{border-color:var(--green);color:var(--green);background:rgba(0,232,122,.06)}
.sport-section{padding:8px 16px}
.match-row{background:var(--s1);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:12px;cursor:pointer;transition:border-color .2s}
.match-row:hover{border-color:var(--border2)}
.match-teams{display:flex;flex-direction:column;gap:4px}
.match-team-row{display:flex;justify-content:space-between;font-size:13px;font-weight:600}
.match-score{font-family:var(--fm);color:var(--green)}
.match-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.match-live-dot{display:flex;align-items:center;gap:4px;font-family:var(--fm);font-size:10px;color:var(--red)}
.match-pred-count{font-size:10px;color:var(--muted2);font-family:var(--fm)}
.guest-nudge{background:rgba(0,232,122,.05);border:1px solid rgba(0,232,122,.15);border-radius:12px;padding:12px 16px;margin:10px 0;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px}
.guest-cta-btn{background:var(--green);color:#06080D;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:800;white-space:nowrap;cursor:pointer}
.toast{position:fixed;top:76px;left:50%;transform:translateX(-50%);background:var(--s1);border:1px solid var(--border2);border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;z-index:500;white-space:nowrap;animation:toIn .25s ease,toOut .25s ease 2.2s forwards;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.toast.s{border-color:rgba(0,232,122,.4);color:var(--green)}
.toast.e{border-color:rgba(255,51,82,.4);color:var(--red)}
.toast.i{border-color:rgba(0,200,255,.3);color:var(--blue)}
@keyframes winPop{0%{opacity:0;transform:translateX(-50%) scale(.7)}60%{transform:translateX(-50%) scale(1.08)}100%{opacity:1;transform:translateX(-50%) scale(1)}}
@keyframes winOut{0%{opacity:1;transform:translateX(-50%) scale(1)}100%{opacity:0;transform:translateX(-50%) scale(.85) translateY(-10px)}}
@keyframes confDot{0%{transform:translateY(0) rotate(0deg);opacity:1}100%{transform:translateY(-90px) rotate(720deg);opacity:0}}
@keyframes winBarDrain{from{width:100%}to{width:0%}}
@keyframes shimmer{0%,100%{opacity:.8}50%{opacity:1}}
.win-notif{position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:600;width:calc(100% - 32px);max-width:360px;background:linear-gradient(135deg,#071510,#0b1f14);border:1.5px solid rgba(0,232,122,.55);border-radius:20px;padding:18px 20px 22px;box-shadow:0 0 48px rgba(0,232,122,.2),0 12px 40px rgba(0,0,0,.7);animation:winPop .4s cubic-bezier(.16,1,.3,1) forwards;overflow:hidden}
.win-notif.out{animation:winOut .3s ease forwards}
.win-notif-glow{position:absolute;top:-40px;left:50%;transform:translateX(-50%);width:220px;height:120px;background:radial-gradient(ellipse,rgba(0,232,122,.18) 0%,transparent 70%);pointer-events:none}
.win-notif-top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.win-notif-icon{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#00E87A,#00b85c);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 0 20px rgba(0,232,122,.5);animation:shimmer 1.4s ease-in-out infinite}
.win-notif-label{font-size:9px;font-weight:700;color:var(--green);letter-spacing:2.5px;text-transform:uppercase;font-family:var(--fm);opacity:.8;margin-bottom:3px}
.win-notif-title{font-family:var(--fa);font-size:22px;letter-spacing:3px;color:#fff;line-height:1}
.win-notif-amount{font-family:var(--fa);font-size:48px;letter-spacing:2px;background:linear-gradient(135deg,#00E87A,#00C8FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1;margin-bottom:6px}
.win-notif-question{font-family:var(--fm);font-size:10px;color:rgba(255,255,255,.45);letter-spacing:.3px;line-height:1.4}
.win-notif-bar{position:absolute;bottom:0;left:0;height:3px;background:linear-gradient(90deg,var(--green),var(--blue));border-radius:0 0 20px 20px}
.conf-wrap{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:601;width:360px;height:100px;pointer-events:none;overflow:hidden}
.conf-dot{position:absolute;border-radius:50%;animation:confDot ease-out forwards}
`;


// ── PROVIDERS & HOOKS
function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = "s") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={"toast " + toast.type}>{toast.msg}</div>}
    </ToastCtx.Provider>
  );
}

function AuthProvider({ children }) {
  const [user, setUser]   = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const login = useCallback(async (email, pw) => {
    setLoading(true); await delay(400);
    let res;
    try { res = await api.login(email, pw); } catch(e) { res = { error: e.message }; }
    setLoading(false);
    if (!res.error) { setUser(res.user); setToken(res.token); }
    return res;
  }, []);
  const register = useCallback(async (email, username, pw, refCode) => {
    setLoading(true); await delay(500);
    let res;
    try { res = await api.register(email, username, pw, refCode); } catch(e) { res = { error: e.message }; }
    setLoading(false);
    if (!res.error) { setUser(res.user); setToken(res.token); }
    return res;
  }, []);
  const logout = useCallback(() => { setUser(null); clearToken(); wsDisconnect(); }, []);
  return <AuthCtx.Provider value={{ user, token, loading, login, register, logout }}>{children}</AuthCtx.Provider>;
}

function WalletProvider({ children }) {
  const auth = useAuth();
  const [wallet, setWallet] = useState(null);
  const [txs, setTxs]       = useState([]);
  const refresh = useCallback(async () => {
    if (!auth.user) return;
    try {
      const [bal, txList] = await Promise.all([api.getBalance(), api.getTransactions()]);
      setWallet(bal);
      setTxs(txList);
    } catch (e) { console.warn('wallet refresh:', e.message); }
  }, [auth.user]);
  useEffect(() => { refresh(); }, [refresh]);
  const deposit  = useCallback(async amt => {
    const r = await api.deposit(amt).catch(e => ({ error: e.message }));
    await refresh(); return r;
  }, [refresh]);
  const withdraw = useCallback(async (amt, clabe) => {
    const r = await api.withdraw(amt, clabe).catch(e => ({ error: e.message }));
    await refresh(); return r;
  }, [refresh]);
  return <WalletCtx.Provider value={{ wallet, txs, refresh, deposit, withdraw }}>{children}</WalletCtx.Provider>;
}

// ── LIVE TIMER
function LiveTimer({ initialTime, onExpire }) {
  const [time, setTime] = useState(initialTime);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);
  useEffect(() => {
    setTime(initialTime);
    let t = initialTime;
    const iv = setInterval(() => {
      t -= 1; setTime(t);
      if (t <= 0) { clearInterval(iv); if (onExpireRef.current) onExpireRef.current(); }
    }, 1000);
    return () => clearInterval(iv);
  }, [initialTime]);
  const hot = time <= 8;
  return (
    <div className="timer-box">
      <div className={"timer-n" + (hot ? " hot" : "")}>{time}</div>
      <div className="timer-l">seg</div>
    </div>
  );
}

// ── MATCH MINUTE BADGE (isolated)
const MatchMinuteBadge = React.memo(function MatchMinuteBadge() {
  const [minute, setMinute] = useState(53);
  useEffect(() => {
    const iv = setInterval(() => setMinute(m => Math.min(m + 1, 90)), 55000);
    return () => clearInterval(iv);
  }, []);
  return <div className="min-badge">{minute + "'"}</div>;
});

// ── PRED ENGINE HOOK (WebSocket-driven)
function useLivePredictions(onWin) {
  const auth       = useAuth();
  const walletCtx  = useWallet();
  const [predictions, setPredictions] = useState([]);
  const [connected, setConnected]     = useState(false);
  const timerRefs  = useRef({});
  const betsRef    = useRef({});   // local bet tracking { predId: { optionIdx, amount } }

  // Merge a server prediction with local userBet state
  const withUserBet = useCallback((pred) => {
    const local = betsRef.current[pred.id];
    return { ...pred, userBet: local || null, timeLeft: pred.timeLeft ?? pred.duration_sec };
  }, []);

  useEffect(() => {
    // Try to load open predictions from REST first
    api.getOpen().then(preds => {
      setPredictions(preds.map(p => withUserBet({ ...p, timeLeft: p.duration_sec })));
    }).catch(() => {});

    // Connect WebSocket for live updates
    wsConnect({
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
      onMessage: (msg) => {
        if (msg.type === 'predictions:init') {
          // Replace full list on connect
          const init = (msg.predictions || []).map(p => withUserBet({ ...p, timeLeft: p.duration_sec }));
          setPredictions(init);
        }
        if (msg.type === 'prediction:new') {
          const p = withUserBet({ ...msg.prediction, timeLeft: msg.prediction.duration_sec });
          setPredictions(prev => [...prev.slice(-5), p]);
        }
        if (msg.type === 'prediction:tick') {
          setPredictions(prev => prev.map(p =>
            p.id === msg.id ? { ...p, timeLeft: msg.timeLeft } : p
          ));
        }
        if (msg.type === 'prediction:resolved') {
          setPredictions(prev => prev.map(p => {
            if (p.id !== msg.predId) return p;
            const userBet = betsRef.current[msg.predId];
            // Check if user won
            if (userBet && msg.resolvedWinner === userBet.optionIdx && onWin) {
              // Fetch history to get payout
              if (auth.user) {
                api.getHistory().then(hist => {
                  const b = hist.find(h => h.prediction_id === msg.predId);
                  if (b && b.status === 'won' && b.payout > 0) {
                    onWin({ payout: parseFloat(b.payout), question: p.question, isJackpot: b.is_jackpot });
                  }
                }).catch(() => {});
              }
            }
            if (walletCtx && auth.user) walletCtx.refresh();
            return { ...p, status:"resolved", timeLeft:0, winner:msg.resolvedWinner, houseWin:msg.houseWin, resolveMode:msg.mode };
          }));
        }
      },
    });

    return () => wsDisconnect();
  }, [withUserBet]);

  const placeBet = useCallback(async (predId, optIdx, amount) => {
    if (!auth.user) return { error: "No autenticado" };
    try {
      await api.placeBet(predId, optIdx, amount);
      betsRef.current[predId] = { optionIdx: optIdx, amount };
      setPredictions(prev => prev.map(p =>
        p.id !== predId ? p : {
          ...p,
          userBet: { optionIdx: optIdx, amount },
          votes: p.votes.map((v, i) => i === optIdx ? v + 1 : v),
          pools: p.pools.map((pl, i) => i === optIdx ? parseFloat(pl) + amount : pl),
          totalPool: parseFloat(p.total_pool || p.totalPool || 0) + amount,
        }
      ));
      if (walletCtx) walletCtx.refresh();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }, [auth.user, walletCtx]);

  return { predictions, placeBet, onPredExpire: () => {}, connected };
}

// ── SVG ICONS (inline, no JSX tag issues)
const IcoHome = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const IcoSearch = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IcoLive = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/></svg>;
const IcoMore = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>;
const IcoTrophy = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>;
const IcoLink = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
const IcoHelp = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
const IcoFile = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
const IcoLogout = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
const IcoChevron = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>;
const IcoWallet = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12V22H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14v4"/><path d="M20 12a2 2 0 0 0-2-2h-2a2 2 0 0 0 0 4h2a2 2 0 0 0 2-2z"/></svg>;
const IcoCheck = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
const IcoDollar = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
const IcoUsers = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;

// ── PRED CARD
const PredCard = React.memo(function PredCard({ pred, onVote, onExpire, t = T.es }) {
  const totalV = pred.votes.reduce((a,b) => a+b, 0);
  const isOpen = pred.status === "open";
  const voted  = pred.userBet != null;
  const pType  = pred.type || PRED_TYPE.STANDARD;
  const isJP   = pType === PRED_TYPE.JACKPOT;
  const isTrip = pType === PRED_TYPE.TRIPLE;

  const handleExpire = useCallback(() => { if (onExpire) onExpire(pred.id); }, [pred.id, onExpire]);

  const cls = "pred-card" + (isOpen && !voted ? " open" : "") + (voted ? " voted" : "") + (!isOpen ? " resolved" : "") + (isJP ? " jackpot" : "");
  const typeLabel = isJP ? "Jackpot" : isTrip ? "Triple" : "Estandar";
  const typeCls   = isJP ? "jackpot" : isTrip ? "triple" : "standard";

  const resolvedContent = () => {
    if (pred.houseWin && pred.resolveMode === "null_event") return <div className="house-win-tag">Evento nulo ({pred.nullLabel}) - pool a Fanbassy</div>;
    if (pred.houseWin && pred.resolveMode === "triple_c")  return <div className="house-win-tag">Triple resultado - pool a Fanbassy</div>;
    if (pred.resolveMode === "jackpot_hit") return pred.userBet && pred.userBet.status === "won" ? <div className="resolved-tag win">JACKPOT - Ganaste {pred.multiplier}x</div> : <div className="house-win-tag">Jackpot - Fanbassy toma el 50%</div>;
    if (pred.userBet == null) return <div className="resolved-tag neutral">{t.winnerWas}: {pred.winner >= 0 ? pred.options[pred.winner] : "-"}</div>;
    if (pred.userBet.optionIdx === pred.winner) return <div className="resolved-tag win">{t.won} - {pred.options[pred.winner]}</div>;
    return <div className="resolved-tag lose">{t.lost} - {t.winnerWas}: {pred.options[pred.winner]}</div>;
  };

  return (
    <div className={cls}>
      <div className={"pred-type-badge " + typeCls}>{typeLabel}</div>
      <div className="pred-top">
        <div className="pred-q">{pred.question}</div>
        {isOpen && <LiveTimer key={pred.id} initialTime={pred.timeLeft} onExpire={handleExpire} />}
      </div>
      {isJP && pred.multiplier && <div style={{padding:"0 14px 6px",display:"flex",alignItems:"center",gap:8}}><span style={{fontFamily:"var(--fa)",fontSize:22,color:"var(--red)",letterSpacing:2}}>{pred.multiplier}x</span><span style={{fontSize:10,color:"var(--muted2)",fontFamily:"var(--fm)"}}>multiplicador si aciertas</span></div>}
      {pType === PRED_TYPE.STANDARD && pred.nullLabel && isOpen && <div className="pred-notice">Si ocurre {pred.nullLabel}: el fondo va a Fanbassy</div>}
      {isTrip && pred.tripleLabel && isOpen && <div className="pred-notice">Si sale "{pred.tripleLabel}": el fondo va a Fanbassy</div>}
      {isJP && isOpen && <div className="pred-notice">Si ocurre: Fanbassy toma el 50%. Si no: el pool se reparte normal.</div>}
      <div className="pred-meta">
        <span>{t.pool}:</span><span className="pool-val">${(pred.totalPool || 0).toFixed(2)}</span>
        <span>-</span><span>{totalV} {t.votes}</span>
        {voted && <span style={{color:"var(--blue)"}}>- {t.yourBet}: ${(pred.userBet && pred.userBet.amount ? pred.userBet.amount : 0).toFixed(2)}</span>}
      </div>
      <div className="opts-grid" style={{gridTemplateColumns:"repeat(" + pred.options.length + ",1fr)"}}>
        {pred.options.map((opt, idx) => {
          const pct  = totalV > 0 ? Math.round(pred.votes[idx]/totalV*100) : 0;
          const isSel  = voted && pred.userBet.optionIdx === idx;
          const isWin  = pred.status === "resolved" && pred.winner === idx;
          const isLose = pred.status === "resolved" && pred.winner !== idx;
          const bc = "opt-btn" + (isSel?" sel":"") + (isWin?" win":"") + (isLose?" lose":"");
          return (
            <button key={idx} className={bc} onClick={() => onVote(idx)} disabled={!isOpen || voted}>
              <div className="opt-top">
                <div className="opt-lbl">{opt}</div>
                <div className="opt-pct">{pct}%</div>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{width:pct+"%"}} /></div>
              <div className="opt-sub">{pred.votes[idx]} - ${(pred.pools[idx] || 0).toFixed(2)}</div>
            </button>
          );
        })}
      </div>
      {pred.status === "resolved" && resolvedContent()}
    </div>
  );
});


// ── WIN NOTIFICATION COMPONENT
function WinNotification({ payout, question, isJackpot, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const DURATION = isJackpot ? 5000 : 3800;

  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), DURATION - 350);
    const t2 = setTimeout(() => onDone(), DURATION);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone, DURATION]);

  // Confetti dots
  const dots = Array.from({ length: 12 }, (_, i) => ({
    left: (10 + i * 7) + "%",
    delay: (i * 0.05) + "s",
    color: ["#00E87A","#00C8FF","#FFB800","#FF3352","#C084FC"][i % 5],
  }));

  return (
    <>
      <div className="confetti-wrap">
        {dots.map((d, i) => (
          <div key={i} className="conf-dot" style={{ left:d.left, top:0, background:d.color, animationDelay:d.delay }} />
        ))}
      </div>
      <div className={"win-notif" + (leaving ? " out" : "")}>
        <div className="win-notif-top">
          <div className="win-notif-icon">{isJackpot ? "⚡" : "🏆"}</div>
          <div>
            <div className="win-notif-label">{isJackpot ? "JACKPOT ACTIVADO" : "PREDICCION ACERTADA"}</div>
            <div className="win-notif-title">{isJackpot ? "JACKPOT" : "GANASTE"}</div>
          </div>
        </div>
        <div className="win-notif-amount">+${payout.toFixed(2)}</div>
        <div className="win-notif-sub">{question ? question.slice(0, 48) + (question.length > 48 ? "..." : "") : "Premio acreditado en tu saldo"}</div>
        <div className="win-notif-bar" style={{ animationDuration: DURATION + "ms" }} />
      </div>
    </>
  );
}

// ── AUTH SCREEN
function AuthScreen() {
  const auth = useAuth();
  const showToast = useToast();
  const [tab, setTab]   = useState("login");
  const [err, setErr]   = useState("");
  const [email, setEmail]     = useState("");
  const [username, setUsername] = useState("");
  const [pw, setPw]           = useState("");
  const [refCode, setRefCode] = useState("");

  async function submit() {
    setErr("");
    const res = tab === "login" ? await auth.login(email, pw) : await auth.register(email, username, pw, refCode);
    if (res.error) setErr(res.error);
    else showToast("Bienvenido" + (res.user ? ", " + res.user.username : "") + "!", "s");
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-logo">FANBASSY</div>
        <div className="auth-sub">Predicciones deportivas en vivo</div>
        <div className="auth-segs">
          <button className={"auth-seg" + (tab==="login"?" active":"")} onClick={() => { setTab("login"); setErr(""); }}>Iniciar sesion</button>
          <button className={"auth-seg" + (tab==="register"?" active":"")} onClick={() => { setTab("register"); setErr(""); }}>Registrarse</button>
        </div>
        {err && <div className="err-msg">{err}</div>}
        {tab === "register" && <div className="field"><label>Usuario</label><input placeholder="tu_usuario" value={username} onChange={e => setUsername(e.target.value)} /></div>}
        <div className="field"><label>Email</label><input type="email" placeholder="tu@email.com" value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label>Contrasena</label><input type="password" placeholder="••••••••" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }} /></div>
        {tab === "register" && <div className="field"><label>Codigo de referido (opcional)</label><input placeholder="ej. DEMO2026" value={refCode} onChange={e => setRefCode(e.target.value.toUpperCase())} /></div>}
        <button className="confirm-btn" style={{marginTop:6}} onClick={submit} disabled={auth.loading}>{auth.loading ? "..." : (tab === "login" ? "ENTRAR" : "CREAR CUENTA")}</button>
        <div className="demo-row">
          <div className="demo-hint">Demo: demo@fanbassy.com / demo123</div>
          <button className="quick-btn" onClick={() => { setEmail("demo@fanbassy.com"); setPw("demo123"); setTimeout(submit, 100); }}>Acceso rapido</button>
        </div>
      </div>
    </div>
  );
}

// ── AUTH GATE MODAL
function AuthGateModal({ onClose }) {
  const auth = useAuth();
  const showToast = useToast();
  const [tab, setTab]   = useState("register");
  const [err, setErr]   = useState("");
  const [email, setEmail]     = useState("");
  const [username, setUsername] = useState("");
  const [pw, setPw]           = useState("");

  async function submit() {
    setErr("");
    const res = tab === "login" ? await auth.login(email, pw) : await auth.register(email, username, pw, "");
    if (res.error) setErr(res.error);
    else { showToast("Bienvenido!", "s"); onClose(); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="handle" />
        <div style={{textAlign:"center",marginBottom:16}}>
          <div className="auth-logo">FANBASSY</div>
          <div style={{fontSize:12,color:"var(--muted2)"}}>Crea tu cuenta gratis para apostar</div>
        </div>
        <div className="auth-segs" style={{marginBottom:14}}>
          <button className={"auth-seg" + (tab==="register"?" active":"")} onClick={() => { setTab("register"); setErr(""); }}>Crear cuenta</button>
          <button className={"auth-seg" + (tab==="login"?" active":"")} onClick={() => { setTab("login"); setErr(""); }}>Iniciar sesion</button>
        </div>
        {err && <div className="err-msg">{err}</div>}
        {tab === "register" && <div className="field"><label>Usuario</label><input placeholder="tu_usuario" value={username} onChange={e => setUsername(e.target.value)} /></div>}
        <div className="field"><label>Email</label><input type="email" placeholder="tu@email.com" value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label>Contrasena</label><input type="password" placeholder="••••••••" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => { if(e.key==="Enter") submit(); }} /></div>
        <button className="confirm-btn" onClick={submit} disabled={auth.loading}>{auth.loading ? "..." : (tab === "register" ? "CREAR CUENTA GRATIS" : "ENTRAR")}</button>
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)",textAlign:"center"}}>
          <button onClick={() => { setEmail("demo@fanbassy.com"); setPw("demo123"); setTimeout(submit,100); }} style={{background:"var(--s2)",border:"1px solid var(--border2)",borderRadius:8,padding:"7px 18px",fontSize:11,fontWeight:700,color:"var(--muted2)"}}>Acceso demo</button>
        </div>
      </div>
    </div>
  );
}

// ── WALLET MODAL
function WalletModal({ onClose }) {
  const walletCtx = useWallet();
  const showToast = useToast();
  const [view, setView]   = useState("txs");
  const [depAmt, setDepAmt] = useState(10);
  const [wAmt, setWAmt]   = useState(5);
  const [clabe, setClabe] = useState("");
  const [loading, setLoading] = useState(false);
  const wallet = walletCtx ? walletCtx.wallet : null;
  const txs    = walletCtx ? walletCtx.txs : [];

  async function doDeposit() {
    setLoading(true);
    const res = await walletCtx.deposit(depAmt);
    setLoading(false);
    if (res.error) showToast(res.error, "e"); else { showToast("+" + depAmt + " depositados", "s"); setView("txs"); }
  }
  async function doWithdraw() {
    setLoading(true);
    const res = await walletCtx.withdraw(wAmt, clabe);
    setLoading(false);
    if (res.error) showToast(res.error, "e"); else { showToast("Retiro solicitado", "i"); setView("txs"); }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div className="modal-title">Mi Wallet</div>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>
        <div style={{textAlign:"center",marginBottom:14}}>
          <div style={{fontSize:10,color:"var(--muted2)",fontFamily:"var(--fm)",textTransform:"uppercase",letterSpacing:1}}>Saldo disponible</div>
          <div style={{fontFamily:"var(--fa)",fontSize:40,color:"var(--green)",letterSpacing:2,lineHeight:1.1}}>${wallet ? wallet.balance.toFixed(2) : "0.00"}</div>
        </div>
        <div className="modal-tabs">
          {[["txs","Movimientos"],["deposit","Depositar"],["withdraw","Retirar"]].map(([v,l]) => (
            <button key={v} className={"modal-tab" + (view===v?" active":"")} onClick={() => setView(v)}>{l}</button>
          ))}
        </div>
        {view === "txs" && (
          <div className="tx-list">
            {txs.length === 0 && <div className="empty-state">Sin movimientos</div>}
            {txs.map(tx => (
              <div key={tx.id} className="tx-row">
                <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0}}>
                  <span className={"tx-tag " + tx.type}>{tx.type}</span>
                  <div>
                    <div style={{fontSize:12}}>{tx.desc}</div>
                    <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--muted2)"}}>{fmtTime(tx.createdAt)}</div>
                  </div>
                </div>
                <div style={{fontFamily:"var(--fm)",fontSize:13,fontWeight:700,color:tx.amount>0?"var(--green)":"var(--red)"}}>{(tx.amount>0?"+":"") + Math.abs(tx.amount||0).toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}
        {view === "deposit" && (
          <div>
            <div className="presets">
              {[5,10,20,50].map(a => <button key={a} className={"preset"+(depAmt===a?" on":"")} onClick={() => setDepAmt(a)}>${a}</button>)}
            </div>
            <input className="amt-input" type="number" min={1} max={500} value={depAmt} onChange={e => setDepAmt(Math.max(1,Math.min(500,+e.target.value)))} />
            <button className="confirm-btn" onClick={doDeposit} disabled={loading}>{loading?"Procesando...":"Depositar $"+depAmt}</button>
          </div>
        )}
        {view === "withdraw" && (
          <div>
            <div className="field"><label>Monto</label><input type="number" min={5} max={wallet?wallet.balance:0} value={wAmt} onChange={e => setWAmt(Math.max(5,Math.min(wallet?wallet.balance:0,+e.target.value)))} /></div>
            <div className="field"><label>CLABE (18 digitos)</label><input placeholder="646180XXXXXXXXXX" maxLength={18} value={clabe} onChange={e => setClabe(e.target.value.replace(/\D/g,""))} /></div>
            <button className="confirm-btn" onClick={doWithdraw} disabled={loading||wAmt>(wallet?wallet.balance:0)||clabe.length!==18}>{loading?"Procesando...":"Solicitar retiro $"+wAmt}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── BET MODAL
function BetModal({ pred, optIdx, onClose, onConfirm, t = T.es }) {
  const walletCtx = useWallet();
  const [amt, setAmt] = useState(1);
  const balance  = walletCtx && walletCtx.wallet ? walletCtx.wallet.balance : 0;
  const optPool  = pred.pools[optIdx] + amt;
  const loserPool = pred.totalPool + amt - optPool;
  const share    = amt / optPool;
  const est      = (amt + loserPool * share * (1 - PredEng.COMMISSION)).toFixed(2);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="handle" />
        <div className="sheet-lbl">Prediccion</div>
        <div className="sheet-q">{pred.question}</div>
        <div className="sheet-opt">{"-> " + pred.options[optIdx]}</div>
        <div style={{fontSize:10,color:"var(--muted2)",fontFamily:"var(--fm)",marginBottom:8}}>Monto a apostar</div>
        <div className="presets">
          {[1,2,5,10].map(a => <button key={a} className={"preset"+(amt===a?" on":"")} onClick={() => setAmt(a)}>${a}</button>)}
        </div>
        <input className="amt-input" type="number" min={0.5} max={balance} step={0.5} value={amt} onChange={e => setAmt(Math.max(0.5, Math.min(balance, +e.target.value)))} />
        <div className="payout-row">
          <div>
            <div className="payout-lbl">{t.estimatedWin}</div>
            <div className="payout-sub">{t.commissionNote}</div>
          </div>
          <div className="payout-val">${est}</div>
        </div>
        <button className="confirm-btn" onClick={() => onConfirm(amt)} disabled={amt > balance || amt <= 0}>{t.confirmBet} ${amt}</button>
        <button className="cancel-btn" onClick={onClose}>{t.cancel}</button>
      </div>
    </div>
  );
}

// ── MAIN APP
function MainApp({ isGuest, onGuestBet }) {
  const auth       = useAuth();
  const walletCtx  = useWallet();
  const showToast  = useToast();
  const [winNotif, setWinNotif] = useState(null);
  const handleWin = useCallback((info) => { setWinNotif(info); }, []);
  const { predictions, placeBet, onPredExpire } = useLivePredictions(handleWin);

  const [lang, setLang]         = useState("es");
  const [screen, setScreen]     = useState("home");
  const [moreOpen, setMoreOpen] = useState(false);
  const [betModal, setBetModal] = useState(null);
  const [walletModal, setWalletModal] = useState(false);
  const [affModal, setAffModal] = useState(false);
  const [predTab, setPredTab]   = useState("open");
  const [activeSport, setActiveSport]   = useState("futbol");
  const [activeLeague, setActiveLeague] = useState("all");

  const t      = T[lang];
  const wallet = walletCtx ? walletCtx.wallet : null;

  let wins = 0, losses = 0;
  DB.bets.forEach(b => {
    if (b.userId === (auth.user && auth.user.id)) {
      if (b.status === "won") wins++;
      else if (b.status === "lost") losses++;
    }
  });
  const wr      = wins + losses > 0 ? Math.round(wins/(wins+losses)*100) : 0;
  const history = auth.user ? PredEng.getUserHistory(auth.user.id) : [];
  const sport   = SPORTS_DATA.find(s => s.id === activeSport) || SPORTS_DATA[0];
  const filteredMatches = activeLeague === "all"
    ? sport.matches
    : sport.matches.filter(m => m.league === activeLeague);
  const open     = predictions.filter(p => p.status === "open");
  const resolved = predictions.filter(p => p.status === "resolved");

  function openVote(pred, idx) {
    if (isGuest) { onGuestBet(); return; }
    if (!pred.userBet && pred.status === "open") setBetModal({ pred, optIdx: idx });
  }
  function confirmBet(amount) {
    const res = placeBet(betModal.pred.id, betModal.optIdx, amount);
    if (res.error) showToast(res.error, "e");
    else showToast(amount.toFixed(2) + " apostado", "s");
    setBetModal(null);
  }

  const navItems = [
    { id:"home",   label:t.navHome,   Ico:IcoHome },
    { id:"live",   label:t.navLive,   Ico:IcoLive, live:true },
    { id:"search", label:t.navSearch, Ico:IcoSearch },
    { id:"more",   label:t.navMore,   Ico:IcoMore },
  ];

  const langOptions = [
    { code:"es", label:"Espanol", flag:"ES" },
    { code:"en", label:"English", flag:"EN" },
  ];

  return (
    <div className="app">
      <style>{CSS}</style>

      {winNotif && (
        <WinNotification
          payout={winNotif.payout}
          question={winNotif.question}
          isJackpot={winNotif.isJackpot}
          onDone={() => setWinNotif(null)}
        />
      )}

      <header className="hdr">
        <div className="logo">{t.appName}</div>
        <div className="hdr-right">
          <div className="live-pill">
            <div className="live-dot" />
            {t.liveNow}
          </div>
          {isGuest ? (
            <>
              <button className="hdr-signin" onClick={onGuestBet}>{t.signIn}</button>
              <button className="hdr-signup" onClick={onGuestBet}>{t.signUpFree}</button>
            </>
          ) : (
            <div className="bal-chip" onClick={() => setWalletModal(true)}>
              <div className="bal-lbl">{t.balance}</div>
              <div className="bal-amt">${wallet ? wallet.balance.toFixed(2) : "0.00"}</div>
            </div>
          )}
        </div>
      </header>

      {screen === "home" && (
        <>
          <div className="match-wrap">
            <div className="match-card">
              <div className="match-hdr">
                <span>{t.worldCup}</span>
                <span>{t.stadium}</span>
                <span style={{color:"var(--muted2)"}}>Oyarzabal 2' · Pedri 32' · Gallese 53' (GEC)</span>
              </div>
              <div className="match-body">
                <div className="team-info">
                  <div className="team-flag">🇪🇸</div>
                  <div className="team-name">Espana</div>
                </div>
                <div className="scorebox">
                  <div className="score-txt">3 - 1</div>
                  <MatchMinuteBadge />
                </div>
                <div className="team-info away">
                  <div className="team-flag">🇵🇪</div>
                  <div className="team-name">Peru</div>
                </div>
              </div>
            </div>
          </div>

          <div className="main-grid">
            <div>
              <div className="nav-tabs">
                <button className={"nav-tab" + (predTab==="open"?" active":"")} onClick={() => setPredTab("open")}>{t.tabOpen} ({open.length})</button>
                <button className={"nav-tab" + (predTab==="resolved"?" active":"")} onClick={() => setPredTab("resolved")}>{t.tabResolved} ({resolved.length})</button>
                {!isGuest && <button className={"nav-tab" + (predTab==="history"?" active":"")} onClick={() => setPredTab("history")}>{t.tabHistory}</button>}
              </div>

              {isGuest && (
                <div className="guest-nudge" onClick={onGuestBet}>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--green)"}}>{t.nudgeTitle}</div>
                    <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{t.nudgeSub}</div>
                  </div>
                  <button className="guest-cta-btn">{t.nudgeCta}</button>
                </div>
              )}

              <div className="pred-list" style={{marginTop:10}}>
                {predTab === "open" && (
                  open.length === 0
                    ? <div className="empty-state">{t.waitingEvent}</div>
                    : open.map(p => <PredCard key={p.id} pred={p} t={t} onVote={idx => openVote(p, idx)} onExpire={onPredExpire} />)
                )}
                {predTab === "resolved" && (
                  resolved.length === 0
                    ? <div className="empty-state">{t.noResolved}</div>
                    : resolved.map(p => <PredCard key={p.id} pred={p} t={t} onVote={() => {}} onExpire={null} />)
                )}
                {predTab === "history" && !isGuest && (
                  history.length === 0
                    ? <div className="empty-state">{t.noHistory}</div>
                    : history.map(b => (
                        <div key={b.id} style={{background:"var(--s1)",border:"1px solid var(--border)",borderRadius:12,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.prediction ? b.prediction.question : ""}</div>
                            <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--muted2)",marginTop:3}}>{b.prediction ? b.prediction.options[b.optionIdx] : ""}</div>
                          </div>
                          <div style={{fontFamily:"var(--fm)",fontSize:13,fontWeight:700,color:b.status==="won"?"var(--green)":b.status==="lost"?"var(--red)":"var(--yellow)"}}>
                            {b.status==="won" ? "+$"+(b.payout||0).toFixed(2) : b.status==="lost" ? "-$"+(b.amount||0).toFixed(2) : t.pending}
                          </div>
                        </div>
                      ))
                )}
              </div>
            </div>

            <div className="sidebar">
              {isGuest ? (
                <div className="card" style={{textAlign:"center",padding:"24px 20px"}}>
                  <div style={{width:48,height:48,borderRadius:12,background:"rgba(0,232,122,.08)",border:"1px solid rgba(0,232,122,.15)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",color:"var(--green)"}}><IcoDollar /></div>
                  <div style={{fontFamily:"var(--fa)",fontSize:18,letterSpacing:2,marginBottom:8}}>{t.guestTitle}</div>
                  <div style={{fontSize:12,color:"var(--muted2)",lineHeight:1.6,marginBottom:14}}>{t.guestSub}</div>
                  {[t.guestBenefit1, t.guestBenefit2, t.guestBenefit3, t.guestBenefit4].map((txt, i) => (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"var(--muted2)",marginBottom:6,textAlign:"left"}}>
                      <span style={{width:14,height:14,color:"var(--green)",flexShrink:0}}><IcoCheck /></span>{txt}
                    </div>
                  ))}
                  <button onClick={onGuestBet} style={{width:"100%",background:"linear-gradient(135deg,var(--green),var(--blue))",border:"none",borderRadius:10,padding:"13px",fontSize:13,fontWeight:800,color:"#06080D",cursor:"pointer",marginTop:10}}>{t.guestCta}</button>
                </div>
              ) : (
                <>
                  <div className="card">
                    <div className="sec-hdr">{t.balance}</div>
                    <div className="bal-big">${wallet ? wallet.balance.toFixed(2) : "0.00"}</div>
                    <div className="stats-grid">
                      <div className="stat-item"><div className="stat-v g">{wins}</div><div className="stat-l">{t.wonLabel}</div></div>
                      <div className="stat-item"><div className="stat-v r">{losses}</div><div className="stat-l">{t.lostLabel}</div></div>
                      <div className="stat-item"><div className="stat-v g">${wallet ? wallet.totalWon.toFixed(2) : "0.00"}</div><div className="stat-l">{t.earnedLabel}</div></div>
                      <div className="stat-item"><div className="stat-v">{wr}%</div><div className="stat-l">{t.winRate}</div></div>
                    </div>
                    <button className="dep-btn" onClick={() => setWalletModal(true)}>{t.depositWithdraw}</button>
                  </div>
                  <div className="card">
                    <div className="sec-hdr">{t.quickHistory}</div>
                    <div className="history-list">
                      {history.length === 0
                        ? <div className="empty-state" style={{padding:"14px 0"}}>{t.noHistory}</div>
                        : history.slice(0,8).map(b => (
                            <div key={b.id} className="hist-item">
                              <div style={{flex:1,minWidth:0,paddingRight:8}}>
                                <div className="hist-q">{b.prediction ? b.prediction.question : ""}</div>
                                <div className="hist-meta">{b.prediction ? b.prediction.options[b.optionIdx] : ""}</div>
                              </div>
                              <div className={"hist-res " + (b.status==="won"?"w":b.status==="lost"?"l":"")}>
                                {b.status==="won" ? "+$"+(b.payout||0).toFixed(2) : b.status==="lost" ? "-$"+(b.amount||0).toFixed(2) : "..."}
                              </div>
                            </div>
                          ))
                      }
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {screen === "live" && (
        <div style={{paddingBottom:80}}>
          <div style={{display:"flex",gap:6,overflowX:"auto",padding:"10px 16px",borderBottom:"1px solid var(--border)"}}>
            {SPORTS_DATA.map(s => {
              const active = activeSport === s.id;
              return (
                <button key={s.id}
                  onClick={() => { setActiveSport(s.id); setActiveLeague("all"); }}
                  style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:20,border:"1px solid",whiteSpace:"nowrap",flexShrink:0,cursor:"pointer",fontSize:12,fontWeight:700,borderColor:active?s.color:"var(--border)",background:active?s.color+"18":"var(--s2)",color:active?s.color:"var(--muted2)"}}>
                  {lang === "es" ? s.nameEs : s.nameEn}
                </button>
              );
            })}
          </div>
          <div className="league-row">
            <button className={"league-chip" + (activeLeague==="all"?" active":"")} onClick={() => setActiveLeague("all")}>{t.allSports}</button>
            {sport.leagues.map(l => (
              <button key={l} className={"league-chip" + (activeLeague===l?" active":"")} onClick={() => setActiveLeague(l)}>{l}</button>
            ))}
          </div>
          <div className="sport-section">
            {filteredMatches.map(m => (
              <div key={m.id} className="match-row" onClick={() => setScreen("home")}>
                <div className="match-teams">
                  <div className="match-team-row"><span>{m.home}</span><span className="match-score">{m.scoreH}</span></div>
                  <div className="match-team-row"><span>{m.away}</span><span className="match-score">{m.scoreA}</span></div>
                </div>
                <div className="match-meta">
                  <div className="match-live-dot"><div className="live-dot" />{m.minute}</div>
                  <div className="match-pred-count">{m.preds} {t.predictions}</div>
                  <div style={{fontSize:10,color:"var(--muted2)",fontFamily:"var(--fm)"}}>{m.league}</div>
                </div>
              </div>
            ))}
          </div>
          {isGuest && (
            <div className="guest-nudge" style={{margin:"0 16px"}} onClick={onGuestBet}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"var(--green)"}}>{t.nudgeTitle}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{t.nudgeSub}</div>
              </div>
              <button className="guest-cta-btn">{t.nudgeCta}</button>
            </div>
          )}
        </div>
      )}

      {screen === "search" && (
        <div style={{padding:"16px",paddingBottom:80}}>
          <div style={{background:"var(--s2)",border:"1px solid var(--border2)",borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <span style={{width:18,height:18,color:"var(--muted2)",flexShrink:0,display:"flex"}}><IcoSearch /></span>
            <span style={{fontSize:14,color:"var(--muted2)"}}>Buscar partidos, deportes, ligas...</span>
          </div>
          {SPORTS_DATA.map(s => (
            <div key={s.id} style={{marginBottom:18}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,fontFamily:"var(--fa)",fontSize:14,letterSpacing:2}}>
                {lang === "es" ? s.nameEs : s.nameEn}
                <span style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--muted2)"}}>{s.matches.length} en vivo</span>
              </div>
              {s.leagues.map(l => (
                <div key={l} style={{padding:"10px 14px",background:"var(--s1)",border:"1px solid var(--border)",borderRadius:10,marginBottom:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,fontWeight:600}}>{l}</span>
                  <span style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"var(--red)",fontFamily:"var(--fm)",fontWeight:700}}>
                    <div className="live-dot" />{t.live}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <nav className="bottom-nav">
        {navItems.map(item => (
          <button key={item.id}
            className={"bn-item" + (screen===item.id?" active":"") + (item.live?" live-indicator":"")}
            onClick={() => item.id === "more" ? setMoreOpen(true) : setScreen(item.id)}>
            <item.Ico />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {moreOpen && (
        <>
          <div className="more-overlay" onClick={() => setMoreOpen(false)} />
          <div className="more-sheet">
            <div className="more-handle" />

            {isGuest && (
              <div style={{padding:"12px 20px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,borderBottom:"1px solid var(--border)"}}>
                <button onClick={() => { setMoreOpen(false); onGuestBet(); }} style={{padding:"10px",borderRadius:10,border:"1px solid var(--border2)",background:"transparent",fontSize:13,fontWeight:700,cursor:"pointer"}}>{t.signIn}</button>
                <button onClick={() => { setMoreOpen(false); onGuestBet(); }} style={{padding:"10px",borderRadius:10,border:"none",background:"linear-gradient(135deg,var(--green),var(--blue))",fontSize:13,fontWeight:800,color:"#06080D",cursor:"pointer"}}>{t.signUp}</button>
              </div>
            )}

            {auth.user && (
              <div style={{padding:"12px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid var(--border)"}}>
                <div style={{width:40,height:40,borderRadius:"50%",background:"var(--s2)",border:"1px solid var(--border2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"var(--green)"}}>
                  {auth.user.username ? auth.user.username[0].toUpperCase() : "?"}
                </div>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>{auth.user.username}</div>
                  <div style={{fontSize:11,color:"var(--muted2)",fontFamily:"var(--fm)"}}>{auth.user.email}</div>
                </div>
                {wallet && (
                  <div style={{marginLeft:"auto",textAlign:"right"}}>
                    <div style={{fontFamily:"var(--fm)",fontSize:15,fontWeight:700,color:"var(--green)"}}>${wallet ? wallet.balance.toFixed(2) : "0.00"}</div>
                    <div style={{fontSize:9,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase"}}>{t.balance}</div>
                  </div>
                )}
              </div>
            )}

            <div className="more-section">
              <div className="more-section-label">Fanbassy</div>
              <button className="more-item">
                <div className="more-item-icon" style={{background:"rgba(255,184,0,.12)"}}><IcoTrophy /></div>
                <div className="more-item-text">
                  <div className="more-item-title">{t.leaderboard}</div>
                  <div className="more-item-sub">{t.leaderboardSub}</div>
                </div>
                <div className="more-item-right"><IcoChevron /></div>
              </button>
              {auth.user && (
                <button className="more-item" onClick={() => { setMoreOpen(false); setAffModal(true); }}>
                  <div className="more-item-icon" style={{background:"rgba(192,132,252,.12)"}}><IcoLink /></div>
                  <div className="more-item-text">
                    <div className="more-item-title">{t.affiliates}</div>
                    <div className="more-item-sub">{t.affiliatesSub}</div>
                  </div>
                  <div className="more-item-right"><IcoChevron /></div>
                </button>
              )}
            </div>

            <div className="more-divider" />

            <div className="more-section">
              <div className="more-section-label">{t.language}</div>
              <div style={{display:"flex",gap:8,paddingBottom:8}}>
                {langOptions.map(lo => (
                  <button key={lo.code} className={"lang-btn" + (lang===lo.code?" active":"")} onClick={() => setLang(lo.code)}>
                    {lo.flag} {lo.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="more-divider" />

            <div className="more-section">
              <button className="more-item">
                <div className="more-item-icon" style={{background:"rgba(0,200,255,.1)"}}><IcoHelp /></div>
                <div className="more-item-text"><div className="more-item-title">{t.help}</div></div>
                <div className="more-item-right"><IcoChevron /></div>
              </button>
              <button className="more-item">
                <div className="more-item-icon" style={{background:"rgba(255,255,255,.05)"}}><IcoFile /></div>
                <div className="more-item-text"><div className="more-item-title">{t.terms}</div></div>
                <div className="more-item-right"><IcoChevron /></div>
              </button>
              {auth.user && (
                <button className="more-item" onClick={() => { setMoreOpen(false); auth.logout(); }}>
                  <div className="more-item-icon" style={{background:"rgba(255,51,82,.1)"}}><IcoLogout /></div>
                  <div className="more-item-text"><div className="more-item-title" style={{color:"var(--red)"}}>{t.logout}</div></div>
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {betModal && <BetModal pred={betModal.pred} optIdx={betModal.optIdx} t={t} onClose={() => setBetModal(null)} onConfirm={confirmBet} />}
      {walletModal && <WalletModal onClose={() => setWalletModal(false)} />}

      {affModal && auth.user && (() => {
        const aff = AffSvc.get(auth.user.id);
        return (
          <div className="modal-wrap" onClick={() => setAffModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-hdr">
                <div className="modal-title">Programa de afiliados</div>
                <button className="close-btn" onClick={() => setAffModal(false)}>x</button>
              </div>
              {aff && (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                    {[{l:"Nivel",v:"Nivel "+aff.level,c:"var(--blue)"},{l:"Comision",v:(aff.commissionPct*100).toFixed(0)+"%",c:"var(--green)"},{l:"Ganado",v:"$"+aff.totalEarned.toFixed(2),c:"var(--green)"}].map((s,i) => (
                      <div key={i} style={{background:"var(--s2)",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                        <div style={{fontFamily:"var(--fm)",fontSize:16,fontWeight:700,color:s.c}}>{s.v}</div>
                        <div style={{fontSize:9,color:"var(--muted2)",textTransform:"uppercase",letterSpacing:1,marginTop:2}}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{background:"var(--s2)",borderRadius:9,padding:"10px 12px",marginBottom:10}}>
                    <div style={{fontSize:10,color:"var(--muted2)",fontFamily:"var(--fm)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Tu codigo</div>
                    <div style={{fontFamily:"var(--fa)",fontSize:22,letterSpacing:4,color:"var(--green)"}}>{aff.code}</div>
                  </div>
                  <div style={{fontSize:11,color:"var(--muted2)",lineHeight:1.8}}>
                    Comparte tu codigo y gana el {(aff.commissionPct*100).toFixed(0)}% de comision por cada referido.
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── ROOT
function AppContent() {
  const auth = useAuth();
  const [showAuth, setShowAuth] = useState(false);
  if (!auth.user) {
    return (
      <>
        <style>{CSS}</style>
        <MainApp isGuest={true} onGuestBet={() => setShowAuth(true)} />
        {showAuth && <AuthGateModal onClose={() => setShowAuth(false)} />}
      </>
    );
  }
  return <MainApp isGuest={false} onGuestBet={() => {}} />;
}

export default function Fanbassy() {
  return (
    <ToastProvider>
      <AuthProvider>
        <WalletProvider>
          <AppContent />
        </WalletProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

