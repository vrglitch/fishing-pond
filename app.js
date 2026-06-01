// Degrees the crank rotates per 10% of bar movement (reel in or out)
const CRANK_DEG_PER_10PCT = 120;
// Degrees of crank rotation between each tick sound during reel-in
const CRANK_DEG_PER_TICK = 36;

let DEFAULTS = {};
let CONFIG = {};

const RARITY_RANK = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Unique: 6 };
const RARITIES = ['Common','Uncommon','Rare','Epic','Legendary','Unique'];

// ============================================================================
// STATE
// ============================================================================
const state = {
  phase: 'idle',
  selectedRod: 'R001',
  selectedBait: 'B001',
  biteAt: 0,
  missAt: 0,
  phaseStartedAt: 0,
  currentCatch: null,
  lastCatchId: null,
  // debug
  debugInvincible: false,
  debugCatchImmortal: false,
  debugRodImmortal: false,
  debugFreeCrank: false,
  isDraggingCrank: false,
  dragLastAngle: 0,
  dragAccumAngle: 0,
  lastTickAngleMark: 0,
  // tension bar & fish zone
  barHeight: 0.1,
  zoneY: 0.1,
  zoneTargetY: 0.1,
  zoneNextChange: 0,
  zoneSize: 0.3,
  fishLife: 1,
  fishLifeMax: 1,
  playerLife: 1,
  playerLifeMax: 1,
  speed: 1,
  randomness: 0.3,
  crankAngle: 0,
  crankPhase: 'idle',      // 'idle'|'animating'|'stopped'
  crankAnimFrom: 0,
  crankAnimTo: 45,
  crankAnimStart: 0,
  reelInFrom: 0,
  reelInTarget: 0,
  reelOutBoost: false,     // W held → 2× rise rate
  pressTimes: [],
  totalPresses: 0,
  stats: { enc: 0, wins: 0, losses: 0, tokens: 0 },
};

// ============================================================================
// AUDIO
// ============================================================================
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
let reelOutSound = null;
function startReelOutSound() {
  if (reelOutSound) return;
  try {
    const ctx = getAudioCtx();
    const bufSize = ctx.sampleRate;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.04);
    src.connect(hp); hp.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
    src.start();
    reelOutSound = { src, gain, ctx };
  } catch(e) {}
}
function stopReelOutSound() {
  if (!reelOutSound) return;
  try {
    const { src, gain, ctx } = reelOutSound;
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.07);
    src.stop(ctx.currentTime + 0.07);
  } catch(e) {}
  reelOutSound = null;
}

function playTick() {
  try {
    const ctx = getAudioCtx();
    const len = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); const gain = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = 0.8 + Math.random() * 0.6;
    src.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    src.start();
  } catch(e) {}
}
function playError() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(); osc.stop(ctx.currentTime + 0.18);
  } catch(e) {}
}

// ============================================================================
// UTILITIES
// ============================================================================
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const getRod = () => CONFIG.rods.find(r => r.id === state.selectedRod) || CONFIG.rods[0];
const getBait = () => CONFIG.baits.find(b => b.id === state.selectedBait) || CONFIG.baits[0];

function log(msg, cls = 'info') {
  const el = $('log');
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-entry ${cls}`;
  div.innerHTML = `<span class="log-time">${time}</span><span>${msg}</span>`;
  el.insertBefore(div, el.firstChild);
  while (el.children.length > 30) el.removeChild(el.lastChild);
}

function updateStats() {
  $('stat-enc').textContent = state.stats.enc;
  $('stat-wins').textContent = state.stats.wins;
  $('stat-losses').textContent = state.stats.losses;
  const total = state.stats.wins + state.stats.losses;
  $('stat-winrate').textContent = total ? Math.round((state.stats.wins / total) * 100) + '%' : '—';
  $('stat-tokens').textContent = state.stats.tokens;
}

function weightedPick(items, weightFn) {
  const total = items.reduce((s, x) => s + weightFn(x), 0);
  if (!total) return items[items.length - 1];
  let r = Math.random() * total;
  for (const x of items) { r -= weightFn(x); if (r <= 0) return x; }
  return items[items.length - 1];
}

function pickCatch() {
  // Force specific catch: read directly from DOM so it's always current
  const forceSel = $('sel-force-catch');
  const forcedId = forceSel ? forceSel.value : '';
  if (forcedId) {
    const forced = CONFIG.catches.find(c => c.id === forcedId);
    if (forced) {
      log(`[Debug] Force catch: ${forced.icon} ${forced.name} (${forced.rarity})`, 'info');
      return forced;
    }
  }

  // Normal path: use selected bait
  const bait = getBait();

  // Tier 1: pick rarity using this bait's own weight table
  const baitWeights = bait.rarityWeights || {};
  const availableRarities = RARITIES.filter(r => (baitWeights[r] ?? 0) > 0);
  if (!availableRarities.length) return null;
  const rarity = weightedPick(availableRarities, r => baitWeights[r]);

  // Tier 2: pick item within that rarity
  const pool = CONFIG.catches.filter(c => c.rarity === rarity);
  return pool.length ? weightedPick(pool, c => c.weight) : null;
}

// ============================================================================
// STATE MACHINE
// ============================================================================
function setPhase(phase) {
  state.phase = phase;
  state.phaseStartedAt = performance.now();

  const buoy = $('buoy');
  const reel = $('reel');
  const reveal = $('catch-reveal');
  reel.classList.remove('active');
  buoy.style.display = 'none';
  buoy.classList.remove('biting');
  reveal.classList.remove('active','win','loss');

  const btnCast = $('btn-cast');
  const btnReel = $('btn-reel');
  const btnStop = $('btn-stop');

  switch (phase) {
    case 'idle':
      $('status-title').textContent = 'Cast your line';
      $('status-sub').textContent = 'Press CAST or SPACE to start fishing';
      btnCast.disabled = false;
      btnReel.disabled = true;
      btnStop.disabled = true;
      break;
    case 'waiting':
      $('status-title').textContent = 'Waiting for a bite…';
      $('status-sub').textContent = 'Something will happen soon';
      buoy.style.display = 'block';
      btnCast.disabled = true;
      btnReel.disabled = true;
      btnStop.disabled = false;
      {
        const wait = rand(CONFIG.timing.biteTimeMin, CONFIG.timing.biteTimeMax);
        state.biteAt = performance.now() + wait * 1000;
      }
      break;
    case 'biting':
      $('status-title').textContent = 'Fish is biting! 🎯';
      $('status-sub').textContent = `Click REEL or press SPACE now!`;
      buoy.style.display = 'block';
      buoy.classList.add('biting');
      btnReel.disabled = false;
      btnCast.disabled = true;
      btnStop.disabled = false;
      state.missAt = performance.now() + CONFIG.timing.biteReactionWindow * 1000;
      break;
    case 'reeling':
      $('status-title').textContent = `Reeling ${state.currentCatch.rarity} ${state.currentCatch.name}…`;
      $('status-sub').textContent = 'Press ↑ to crank · keep the bar on the fish';
      reel.classList.add('active');
      btnReel.disabled = true;
      btnCast.disabled = true;
      btnStop.disabled = false;
      initReeling();
      break;
    case 'revealing':
      btnReel.disabled = true;
      btnStop.disabled = true;
      break;
  }
  $('r-state').textContent = phase;
}

function cast() {
  if (state.phase !== 'idle') return;
  state.stats.enc++;
  updateStats();
  log(`Cast with ${getRod().name} + ${getBait().name}`, 'info');
  setPhase('waiting');
}

function stop() {
  if (state.phase === 'idle' || state.phase === 'revealing') return;
  stopReelOutSound();
  log('Fishing cancelled.', 'info');
  setPhase('idle');
}

function triggerBite() {
  const c = pickCatch();
  if (!c) {
    const forceSel = $('sel-force-catch');
    const forced = (forceSel && forceSel.value) ? ` (forced catch ${forceSel.value} not found in pool)` : ' (bait rank too low)';
    log(`No valid catch${forced}.`, 'loss');
    setPhase('idle');
    return;
  }
  state.currentCatch = c;
  state.lastCatchId = c.id;
  setPhase('biting');
}

function startReeling() {
  if (state.phase !== 'biting') return;
  setPhase('reeling');
}

function initReeling() {
  const c = state.currentCatch;
  const rod = getRod();

  state.zoneSize = c.zoneSize / 100;
  state.speed = c.speed * (rod.speedMult / 100);
  state.randomness = c.randomness / 100;
  state.fishLifeMax = c.hp;
  state.fishLife = state.fishLifeMax;
  state.playerLifeMax = rod.hp;
  state.playerLife = state.playerLifeMax;

  // Pick a random start position so zone is already there — no lerp animation on entry
  const margin = state.zoneSize / 2 + 0.02;
  const startY = margin + Math.random() * (1 - 2 * margin);
  state.zoneY = startY;
  state.zoneTargetY = startY;
  state.zoneNextChange = performance.now() + 1200;  // first move after 1.2s

  // Indicator starts at the zone center so player is immediately in the zone
  state.barHeight = startY;

  state.reelOutBoost = false;
  state.isDraggingCrank = false;
  state.dragAccumAngle = 0;
  state.lastTickAngleMark = 0;
  state.pressTimes = [];
  state.totalPresses = 0;
  state.crankAngle = 0;
  state.crankPhase = 'stopped';
  state.crankAnimFrom = 0;
  state.crankAnimTo = 45;
  state.crankAnimStart = 0;
  state.reelInFrom = 0;
  state.reelInTarget = 0;
  const cg = $('crank-g');
  if (cg) cg.setAttribute('transform', 'rotate(0 130 130)');
}

function reelSucceed() {
  stopReelOutSound();
  state.stats.wins++;
  state.stats.tokens += state.currentCatch.cashback;
  updateStats();
  log(`✓ Caught ${state.currentCatch.name} (+${state.currentCatch.cashback} Tk)`, 'win');
  revealCatch(true);
}

function reelFail() {
  stopReelOutSound();
  state.stats.losses++;
  updateStats();
  log(`✗ Lost the ${state.currentCatch.name}`, 'loss');
  revealCatch(false);
}

function revealCatch(win) {
  setPhase('revealing');
  const reveal = $('catch-reveal');
  $('catch-icon').textContent = win ? state.currentCatch.icon : '💔';
  $('catch-name').textContent = win ? state.currentCatch.name : 'Got away…';
  $('catch-sub').textContent = win
    ? `${state.currentCatch.rarity} · +${state.currentCatch.cashback} tokens`
    : `It was a ${state.currentCatch.rarity} ${state.currentCatch.name}`;
  reveal.classList.add('active', win ? 'win' : 'loss');
  $('status-title').textContent = win ? 'Catch!' : 'Lost…';
  $('status-sub').textContent = ' ';
  setTimeout(() => setPhase('idle'), 2200);
}

// ============================================================================
// INPUT — UP arrow cranks the reel
// ============================================================================
function handleReelPress() {
  if (state.phase !== 'reeling') return;
  if (state.isDraggingCrank) return;
  if (state.reelOutBoost) return;
  if (state.crankPhase === 'animating') return;  // still spinning, ignore

  const now = performance.now();
  const kbd = $('kbd-w');
  if (kbd) { kbd.classList.add('pressed'); setTimeout(() => kbd.classList.remove('pressed'), 120); }

  const rod = getRod();
  if (state.barHeight >= 1) return; // already at top, nothing to reel in
  state.reelInFrom         = state.barHeight;
  state.reelInTarget       = Math.min(1, state.barHeight + rod.reelIn / 100);
  state.pressTimes.push(now);
  state.totalPresses++;
  while (state.pressTimes.length && now - state.pressTimes[0] > 2000) state.pressTimes.shift();
  state.crankAnimFrom      = state.crankAngle;
  state.crankAnimTo        = state.crankAngle + (rod.reelIn / 10) * CRANK_DEG_PER_10PCT;
  state.crankAnimStart     = now;
  state.crankPhase         = 'animating';
  state.lastTickAngleMark  = state.crankAngle;
}

window.addEventListener('keyup', (e) => {
  if (e.key === 's' || e.key === 'S') {
    state.reelOutBoost = false;
    stopReelOutSound();
    const kS = $('kbd-s');
    if (kS) kS.classList.remove('pressed');
  }
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.key) {
    case 'ArrowUp': case 'w': case 'W':
      e.preventDefault();
      handleReelPress();
      break;
    case 's': case 'S': {
      e.preventDefault();
      if (state.phase === 'reeling') {
        state.reelOutBoost = true;
        startReelOutSound();
        const kS = $('kbd-s');
        if (kS) kS.classList.add('pressed');
      }
      break;
    }
    case ' ':
      e.preventDefault();
      if (state.phase === 'idle') cast();
      else if (state.phase === 'biting') startReeling();
      break;
    case 'Escape':
      e.preventDefault();
      stop();
      break;
    case 'r': case 'R':
      // Quick-repeat last catch at same difficulty
      if (state.phase === 'idle' && state.lastCatchId) {
        const c = CONFIG.catches.find(x => x.id === state.lastCatchId);
        if (c) {
          state.stats.enc++;
          updateStats();
          state.currentCatch = c;
          log(`[Debug] Replay ${c.name}`, 'info');
          setPhase('biting');
        }
      }
      break;
  }
});

// ============================================================================
// CRANK — MOUSE DRAG (circular motion)
// ============================================================================
function getCrankAngleFromEvent(e) {
  const stage = $('reel-stage');
  const rect = stage.getBoundingClientRect();
  return Math.atan2(
    e.clientY - rect.top  - rect.height / 2,
    e.clientX - rect.left - rect.width  / 2
  ) * 180 / Math.PI;
}

$('reel-stage').addEventListener('mousedown', e => {
  if (state.phase !== 'reeling') return;
  state.isDraggingCrank = true;
  state.dragLastAngle = getCrankAngleFromEvent(e);
  state.dragAccumAngle = 0;
  $('reel-stage').classList.add('dragging');
  e.preventDefault();
});

window.addEventListener('mousemove', e => {
  if (!state.isDraggingCrank) return;
  if (state.phase !== 'reeling') { state.isDraggingCrank = false; $('reel-stage').classList.remove('dragging'); return; }

  const cur = getCrankAngleFromEvent(e);
  let delta = cur - state.dragLastAngle;
  if (delta >  180) delta -= 360;
  if (delta < -180) delta += 360;
  state.dragLastAngle = cur;

  if (delta > 0 && !state.reelOutBoost) {
    state.dragAccumAngle += delta;
    const rod = getRod();
    const crankDegs = (rod.reelIn / 10) * CRANK_DEG_PER_10PCT;
    if (state.dragAccumAngle >= crankDegs && state.crankPhase !== 'animating' && state.barHeight < 1) {
      state.dragAccumAngle -= crankDegs;
      const now = performance.now();
      state.reelInFrom        = state.barHeight;
      state.reelInTarget      = Math.min(1, state.barHeight + rod.reelIn / 100);
      state.crankAnimFrom     = state.crankAngle;
      state.crankAnimTo       = state.crankAngle + crankDegs;
      state.crankAnimStart    = now;
      state.crankPhase        = 'animating';
      state.lastTickAngleMark = state.crankAngle;
      state.pressTimes.push(now);
      state.totalPresses++;
      while (state.pressTimes.length && now - state.pressTimes[0] > 2000) state.pressTimes.shift();
    }
  }
});

window.addEventListener('mouseup', () => {
  if (!state.isDraggingCrank) return;
  state.isDraggingCrank = false;
  $('reel-stage').classList.remove('dragging');
});

// ============================================================================
// GAME LOOP
// ============================================================================
let lastTick = performance.now();
function tick(now) {
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;

  // Phase transitions
  if (state.phase === 'waiting' && now >= state.biteAt) {
    triggerBite();
  } else if (state.phase === 'biting' && now >= state.missAt) {
    log('Missed the bite.', 'loss');
    state.stats.losses++;
    updateStats();
    setPhase('idle');
  } else if (state.phase === 'reeling') {
    stepReeling(dt, now);
  }

  render();
  renderReadouts(now);
  requestAnimationFrame(tick);
}

function stepReeling(dt, now) {
  const rod = getRod();
  const animMs = rod.responsiveness;

  // --- Crank animation ---
  const passiveBackRate = (rod.reelOut / 10) * CRANK_DEG_PER_10PCT;
  if (state.reelOutBoost) {
    // S held: 2× backwards, cancel any forward animation
    if (state.crankPhase === 'animating') state.crankPhase = 'stopped';
    if (state.barHeight > 0)
      state.crankAngle = ((state.crankAngle - passiveBackRate * 2 * dt) % 360 + 360) % 360;
  } else if (state.crankPhase === 'animating') {
    // Forward crank animation takes priority over passive drift
    const t = Math.min(1, (now - state.crankAnimStart) / animMs);
    const ease = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2;
    state.crankAngle = state.crankAnimFrom + (state.crankAnimTo - state.crankAnimFrom) * ease;
    state.barHeight  = state.reelInFrom + (state.reelInTarget - state.reelInFrom) * t;

    while (state.crankAngle >= state.lastTickAngleMark + CRANK_DEG_PER_TICK) {
      state.lastTickAngleMark += CRANK_DEG_PER_TICK;
      playTick();
    }

    if (t >= 1) {
      state.crankAngle = state.crankAnimTo % 360;
      state.barHeight  = state.reelInTarget;
      state.crankPhase = 'stopped';
    }
  } else {
    // Passive reel-out: crank drifts backwards continuously
    if (state.barHeight > 0 && !state.debugFreeCrank)
      state.crankAngle = ((state.crankAngle - passiveBackRate * dt) % 360 + 360) % 360;
  }

  // --- Indicator falls (line reeling out); S hold = 2× rate ---
  if (state.crankPhase !== 'animating') {
    state.barHeight = Math.max(0, state.barHeight - (rod.reelOut / 100) * (state.reelOutBoost ? 2 : 1) * dt);
  }

  // --- Fish zone movement ---
  if (now >= state.zoneNextChange) {
    const margin = state.zoneSize / 2 + 0.02;
    state.zoneTargetY = margin + Math.random() * (1 - 2 * margin);
    const baseInterval = 1400 / state.speed;
    const jitter = baseInterval * state.randomness;
    state.zoneNextChange = now + baseInterval + (Math.random() * 2 - 1) * jitter;
  }
  state.zoneY += (state.zoneTargetY - state.zoneY) * Math.min(1, 1.6 * state.speed * dt);

  // --- Zone hit: bar top must reach fish zone ---
  const zTop   = state.zoneY + state.zoneSize / 2;
  const zBot   = state.zoneY - state.zoneSize / 2;
  const inZone = state.barHeight >= zBot && state.barHeight <= zTop;

  // --- Life mechanics ---
  if (inZone && !state.debugCatchImmortal) {
    state.fishLife = Math.max(0, state.fishLife - CONFIG.global.fishDps * dt);
  } else if (!inZone && !state.debugInvincible && !state.debugRodImmortal) {
    state.playerLife = Math.max(0, state.playerLife - CONFIG.global.playerDps * dt);
  }

  if (!state.debugCatchImmortal && state.fishLife <= 0) { reelSucceed(); return; }
  if (!state.debugRodImmortal && state.playerLife <= 0) { reelFail(); return; }
}

// ============================================================================
// RENDER
// ============================================================================
function render() {
  if (state.phase !== 'reeling') return;
  const now = performance.now();

  // --- Crank arm rotation ---
  const cg = $('crank-g');
  if (cg) cg.setAttribute('transform', `rotate(${state.crankAngle} 130 130)`);

  // --- Hide beat-timer arc (no expiry) ---
  const arc = $('wait-arc');
  if (arc) arc.setAttribute('stroke-dasharray', '0 748');

  // --- Line indicator position + in-zone colour ---
  const ind = $('line-indicator');
  if (ind) {
    ind.style.bottom = (state.barHeight * 100) + '%';
    const zTop = state.zoneY + state.zoneSize / 2;
    const zBot = state.zoneY - state.zoneSize / 2;
    ind.classList.toggle('in-zone', state.barHeight >= zBot && state.barHeight <= zTop);
  }

  // --- Fish marker position (zoneY: 0=bottom,1=top → CSS bottom%) ---
  const fishMk = $('fish-marker');
  if (fishMk) fishMk.style.bottom = (state.zoneY * 100) + '%';

  // --- Zone band (visual range around fish) ---
  const band = $('zone-band');
  if (band) {
    const botPct = (state.zoneY - state.zoneSize / 2) * 100;
    const htPct  = state.zoneSize * 100;
    band.style.bottom = botPct + '%';
    band.style.height = htPct + '%';
  }

  // --- Life bars ---
  const fpct = (state.fishLife / state.fishLifeMax) * 100;
  const ppct = (state.playerLife / state.playerLifeMax) * 100;
  $('fish-life').style.width = fpct + '%';
  $('player-life').style.width = ppct + '%';
  $('fish-life-text').textContent = Math.round(state.fishLife) + ' / ' + state.fishLifeMax;
  $('player-life-text').textContent = Math.round(state.playerLife) + ' / ' + state.playerLifeMax;
}

function renderReadouts(now) {
  const p = state.phase;
  const elapsed = ((now - state.phaseStartedAt) / 1000).toFixed(1) + 's';
  $('r-phase-t').textContent = elapsed;

  if (p === 'waiting') {
    $('r-bite-t').textContent = Math.max(0, ((state.biteAt - now) / 1000)).toFixed(1) + 's';
  } else if (p === 'biting') {
    const remaining = Math.max(0, (state.missAt - now) / 1000);
    const el = $('r-bite-t');
    el.textContent = 'MISS IN ' + remaining.toFixed(1) + 's';
    el.className = 'readout-value bad';
  } else {
    $('r-bite-t').textContent = '—';
    $('r-bite-t').className = 'readout-value';
  }

  if (state.currentCatch && (p === 'biting' || p === 'reeling' || p === 'revealing')) {
    $('r-catch').innerHTML = `<span class="rarity-tag r-${state.currentCatch.rarity}">${state.currentCatch.rarity}</span> ${state.currentCatch.icon} ${state.currentCatch.name}`;
  } else {
    $('r-catch').textContent = '—';
  }

  if (p === 'reeling') {
    $('r-player').textContent = `bar:${state.barHeight.toFixed(2)}  crank:${Math.round(state.crankAngle)}° [${state.crankPhase}]`;
    $('r-zone').textContent   = `${state.zoneY.toFixed(2)} / ${state.zoneSize.toFixed(2)}`;
    const zTop = state.zoneY + state.zoneSize / 2;
    const zBot = state.zoneY - state.zoneSize / 2;
    const inZ = state.barHeight >= zBot && state.barHeight <= zTop;
    const el = $('r-inzone');
    el.textContent = inZ ? 'YES' : 'no';
    el.className = 'readout-value ' + (inZ ? 'good' : 'bad');
    $('r-fl').textContent = `${Math.round(state.fishLife)} / ${state.fishLifeMax} HP`;
    $('r-pl').textContent = `${Math.round(state.playerLife)} / ${state.playerLifeMax} HP`;
    const rate = state.pressTimes.length / 2;
    $('r-prate').textContent = rate.toFixed(1) + ' Hz';
    $('r-pcount').textContent = state.totalPresses;
  } else {
    $('r-player').textContent = '—';
    $('r-zone').textContent = '—';
    $('r-inzone').textContent = '—';
    $('r-inzone').className = 'readout-value';
    $('r-fl').textContent = '—';
    $('r-pl').textContent = '—';
    $('r-prate').textContent = '0 Hz';
  }
}

// ============================================================================
// PERSISTENCE
// ============================================================================
function saveConfig() {
  try { localStorage.setItem('fishingPondConfig', JSON.stringify(CONFIG)); } catch(e) {}
}

function migrateConfig(cfg) {
  delete cfg.catchesDefaults;
  delete cfg.rarityDifficulty;
  if (cfg.physics !== undefined && cfg.global === undefined) { cfg.global = cfg.physics; delete cfg.physics; }
  // Rod property renames
  if (cfg.rods) {
    cfg.rods.forEach(r => {
      if (r.lifeBonus !== undefined && r.life === undefined) {
        r.life = 1 + r.lifeBonus / 100;
        delete r.lifeBonus;
      }
      if (r.barFallRate !== undefined && r.reelOut === undefined) { r.reelOut = r.barFallRate; delete r.barFallRate; }
      if (r.barImpulse  !== undefined && r.reelIn  === undefined) { r.reelIn  = r.barImpulse;  delete r.barImpulse; }
      if (r.reelOutSpeed  !== undefined && r.reelOut         === undefined) { r.reelOut        = r.reelOutSpeed;  delete r.reelOutSpeed; }
      if (r.reelInImpulse !== undefined && r.reelIn          === undefined) { r.reelIn         = r.reelInImpulse; delete r.reelInImpulse; }
      if (r.crankAnimMs   !== undefined && r.responsiveness  === undefined) { r.responsiveness = r.crankAnimMs;   delete r.crankAnimMs; }
    });
  }
  // Catch property renames
  if (cfg.catches) {
    cfg.catches.forEach(c => {
      if (c.unpredictable !== undefined && c.randomness === undefined) { c.randomness = c.unpredictable; delete c.unpredictable; }
    });
  }
  // Scale life values from fractional (≤5) to integer points (×100)
  if (cfg.global && cfg.global.fishDps < 5) {
    cfg.global.fishDps   = Math.round(cfg.global.fishDps   * 100);
    cfg.global.playerDps = Math.round(cfg.global.playerDps * 100);
  }
  if (cfg.rods) {
    cfg.rods.forEach(r => { if (r.life < 5) r.life = Math.round(r.life * 100); });
  }
  if (cfg.catches) {
    cfg.catches.forEach(c => { if (c.life !== undefined && c.life < 5) c.life = Math.round(c.life * 100); });
  }
  // Scale zoneSize/randomness from 0–1 fractions to 0–100 integer percent
  if (cfg.catches) {
    cfg.catches.forEach(c => {
      if (c.zoneSize !== undefined && c.zoneSize < 2) c.zoneSize = Math.round(c.zoneSize * 100);
      if (c.randomness !== undefined && c.randomness < 2) c.randomness = Math.round(c.randomness * 100);
    });
  }
  // Rename 'life' → 'hp' on all entities (final step, after all value scaling)
  if (cfg.rods) cfg.rods.forEach(r => { if (r.life !== undefined && r.hp === undefined) { r.hp = r.life; delete r.life; } });
  if (cfg.catches) cfg.catches.forEach(c => { if (c.life !== undefined && c.hp === undefined) { c.hp = c.life; delete c.life; } });
  // Scale rod speedMult/reelOut/reelIn from fractions to integer %
  if (cfg.rods) {
    cfg.rods.forEach(r => {
      if (r.speedMult     !== undefined && r.speedMult     < 2) r.speedMult     = Math.round(r.speedMult     * 100);
      if (r.reelOut  !== undefined && r.reelOut  < 2) r.reelOut  = Math.round(r.reelOut  * 100);
      if (r.reelIn !== undefined && r.reelIn < 2) r.reelIn = Math.round(r.reelIn * 100);
    });
  }
  // Migrate baits: unlockRank → per-bait rarityWeights; remove top-level rarityWeights
  delete cfg.rarityWeights;
  if (cfg.baits) {
    cfg.baits.forEach(b => {
      if (!b.rarityWeights) {
        const defBait = DEFAULTS.baits.find(db => db.id === b.id);
        b.rarityWeights = defBait ? structuredClone(defBait.rarityWeights) : { Common: 100 };
      }
      delete b.unlockRank;
    });
  }
  // Strip immortal field if present in old saves (no longer part of data model)
  if (cfg.rods) cfg.rods.forEach(r => { delete r.immortal; });
  if (cfg.catches) cfg.catches.forEach(c => { delete c.immortal; });
  return cfg;
}

// ============================================================================
// DEBUG UI — generate sliders/tables from CONFIG
// ============================================================================
function makeSlider(parent, label, obj, key, opts) {
  const { min, max, step = 0.01, unit = '', format = v => v, tip = '', defVal } = opts;
  const row = document.createElement('div');
  const labelRow = document.createElement('div');
  labelRow.className = 'slider-label';
  const nameSpan = document.createElement('span'); nameSpan.className = 'name';
  if (tip) {
    nameSpan.innerHTML = `${label} <span class="tip" data-tip="${tip}">?</span>`;
  } else {
    nameSpan.textContent = label;
  }
  const valSpan = document.createElement('strong'); valSpan.textContent = format(obj[key]) + unit;
  labelRow.appendChild(nameSpan); labelRow.appendChild(valSpan);

  const controls = document.createElement('div');
  controls.className = 'slider-row';

  const range = document.createElement('input');
  range.type = 'range'; range.min = min; range.max = max; range.step = step;
  range.value = obj[key];

  const num = document.createElement('input');
  num.type = 'number'; num.min = min; num.max = max; num.step = step;
  num.value = obj[key];

  const checkModified = (val) => {
    const isModified = defVal !== undefined && Math.abs(val - defVal) > 1e-9;
    valSpan.classList.toggle('modified', isModified);
    num.classList.toggle('modified', isModified);
  };

  const sync = (v) => {
    const val = Number(v);
    obj[key] = val;
    range.value = val; num.value = val;
    valSpan.textContent = format(val) + unit;
    checkModified(val);
    saveConfig();
  };
  range.oninput = e => sync(e.target.value);
  num.onchange = e => sync(e.target.value);

  checkModified(obj[key]);

  controls.appendChild(range); controls.appendChild(num);
  row.appendChild(labelRow); row.appendChild(controls);
  parent.appendChild(row);
}

function buildDebugUI() {
  // Timing
  const timing = $('timing-body'); timing.innerHTML = '';
  makeSlider(timing, 'Bite time — MIN', CONFIG.timing, 'biteTimeMin', { min: 0.5, max: 30, step: 0.5, unit: 's', defVal: DEFAULTS.timing.biteTimeMin });
  makeSlider(timing, 'Bite time — MAX', CONFIG.timing, 'biteTimeMax', { min: 1, max: 120, step: 1, unit: 's', defVal: DEFAULTS.timing.biteTimeMax });
  makeSlider(timing, 'Reaction window', CONFIG.timing, 'biteReactionWindow', { min: 0.5, max: 10, step: 0.1, unit: 's', defVal: DEFAULTS.timing.biteReactionWindow });
  const help1 = document.createElement('div');
  help1.className = 'help-text';
  help1.textContent = 'In production these should be 30s / 120s. Small values = fast testing.';
  timing.appendChild(help1);

  // Physics
  const phys = $('global-body'); phys.innerHTML = '';
  makeSlider(phys, 'Fish DPS (in zone)',    CONFIG.global, 'fishDps',   { min: 1, max: 200, step: 1, unit: ' pts/s', defVal: DEFAULTS.global.fishDps });
  makeSlider(phys, 'Player DPS (out zone)', CONFIG.global, 'playerDps', { min: 1, max: 200, step: 1, unit: ' pts/s', defVal: DEFAULTS.global.playerDps });
  const help2 = document.createElement('div'); help2.className = 'help-text';
  help2.textContent = 'Per-rod global (reelOut, reelIn, responsiveness) are under the RODS section.';
  phys.appendChild(help2);

  // Rods table
  buildRodsTable();
  buildBaitsTable();
  buildCatchesTable();

  // Dropdowns
  rebuildSelects();
}

function buildRodsTable() {
  const rods = $('rods-body'); rods.innerHTML = '';
  const t = document.createElement('table'); t.className = 'debug-table';
  t.innerHTML = `<thead><tr>
    <th>ID</th><th>Name</th><th>Rarity</th>
    <th><span class="tip" data-tip="Player HP pool (absolute).\nLoss rate: playerDps per second while indicator misses fish zone.\nHigher = more forgiving rod.">HP</span></th>
    <th><span class="tip" data-tip="Multiplies the catch's base speed (as %).\nFormula: effectiveSpeed = catch.speed × (speedMult / 100)\nLower value = slower fish = easier.\n100 = no change · 50 = half speed">Speed</span></th>
    <th><span class="tip" data-tip="How fast the indicator drifts down per second (line reeling out), as %.\nFormula: barHeight -= (reelOut / 100) × dt\nLower = more forgiving (slower drift).">Reel Out</span></th>
    <th><span class="tip" data-tip="Indicator rise per crank step (as %).\nFormula: barHeight += reelIn / 100\nHigher = easier to reel in.">Reel In</span></th>
    <th><span class="tip" data-tip="Duration of the crank rotation animation (ms).\nLower = faster spin = snappier feel.\nDoes not affect bar or fish — visual/feel only.">Responsive</span></th>
  </tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  CONFIG.rods.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--text-muted)">${r.id}</td>
      <td>${r.name}</td>
      <td><span class="rarity-tag r-${r.rarity}">${r.rarity}</span></td>
    `;
    [['hp', '5'], ['speedMult', '1'], ['reelOut', '1'], ['reelIn', '1'], ['responsiveness', '10']].forEach(([prop, step]) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number'; input.value = r[prop]; input.step = step;
      const defRod = DEFAULTS.rods.find(dr => dr.id === r.id);
      const defVal = defRod ? defRod[prop] : undefined;
      const checkMod = () => { if (defVal !== undefined) input.classList.toggle('modified', Math.abs(r[prop] - defVal) > 1e-9); };
      input.onchange = e => { r[prop] = Number(e.target.value) || 0; checkMod(); saveConfig(); };
      checkMod();
      td.appendChild(input); tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  rods.appendChild(t);
}

function buildBaitsTable() {
  const baits = $('baits-body'); baits.innerHTML = '';
  const t = document.createElement('table'); t.className = 'debug-table';
  const rarHdrs = RARITIES.map(r =>
    `<th><span class="tip rarity-tag r-${r}" style="font-size:8px;cursor:help" data-tip="Weight for ${r} rarity when this bait is equipped.\nOnly non-zero rarities are in the roll.\nFormula: chance = weight ÷ sum(all non-zero weights)">${r}</span></th>`
  ).join('');
  t.innerHTML = `<thead><tr><th>ID</th><th>Name</th><th>Rarity</th>${rarHdrs}<th></th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  CONFIG.baits.forEach(b => {
    const defBait = DEFAULTS.baits.find(db => db.id === b.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--text-muted)">${b.id}</td>
      <td>${b.name}</td>
      <td><span class="rarity-tag r-${b.rarity}">${b.rarity}</span></td>
    `;
    RARITIES.forEach(r => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1';
      if (!b.rarityWeights) b.rarityWeights = {};
      input.value = b.rarityWeights[r] ?? 0;
      const defVal = defBait?.rarityWeights?.[r] ?? 0;
      const checkMod = () => input.classList.toggle('modified', (b.rarityWeights[r] ?? 0) !== defVal);
      input.onchange = e => { b.rarityWeights[r] = Number(e.target.value) || 0; checkMod(); saveConfig(); };
      checkMod();
      td.appendChild(input); tr.appendChild(td);
    });
    const diceTd = document.createElement('td');
    const diceBtn = document.createElement('button');
    diceBtn.className = 'roll-sim-btn'; diceBtn.textContent = '🎲';
    diceBtn.title = `Simulate 100 rolls with ${b.name}`;
    diceBtn.addEventListener('click', e => { e.stopPropagation(); showRollPopup(b, e.currentTarget); });
    diceTd.appendChild(diceBtn); tr.appendChild(diceTd);
    tb.appendChild(tr);
  });
  baits.appendChild(t);
  const help = document.createElement('div'); help.className = 'help-text';
  help.textContent = 'Rarity weights are relative — they don\'t need to sum to 100. Only non-zero entries are included in the roll.';
  baits.appendChild(help);
}

function buildCatchesTable() {
  const catches = $('catches-body'); catches.innerHTML = '';
  const t = document.createElement('table'); t.className = 'debug-table';
  t.innerHTML = `<thead><tr>
    <th></th><th>Name</th><th>Rarity</th>
    <th><span class="tip" data-tip="Relative pick chance within this item's rarity bucket.\nHigher weight = more likely to be chosen when that rarity is rolled.">Weight</span></th>
    <th><span class="tip" data-tip="Token reward on successful catch.">Tokens</span></th>
    <th><span class="tip" data-tip="Catchable zone size (0–100%).\nLarger = easier to keep indicator on fish.">Zone</span></th>
    <th><span class="tip" data-tip="Fish movement speed.\nFormula: changeInterval = 1400ms ÷ speed">Speed</span></th>
    <th><span class="tip" data-tip="Movement randomness (0–100%).\nHigher = more erratic.">Random</span></th>
    <th><span class="tip" data-tip="Fish HP pool (absolute).\nDrained by fishDps per second while indicator overlaps zone.">HP</span></th>
    <th></th>
  </tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  CONFIG.catches.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.icon}</td>
      <td>${c.name}</td>
      <td><span class="rarity-tag r-${c.rarity}">${c.rarity}</span></td>
    `;
    const defCatch = DEFAULTS.catches.find(dc => dc.id === c.id);
    [['weight','1'],['cashback','1'],['zoneSize','1'],['speed','0.1'],['randomness','1'],['hp','5']].forEach(([prop, step]) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number'; input.value = c[prop]; input.step = step; input.min = '0';
      const defVal = defCatch ? defCatch[prop] : undefined;
      const checkMod = () => { if (defVal !== undefined) input.classList.toggle('modified', Math.abs(c[prop] - defVal) > 1e-9); };
      input.onchange = e => { c[prop] = Number(e.target.value) || 0; checkMod(); saveConfig(); };
      checkMod();
      td.appendChild(input); tr.appendChild(td);
    });
    const diceTd = document.createElement('td');
    const diceBtn = document.createElement('button');
    diceBtn.className = 'roll-sim-btn'; diceBtn.textContent = '🎲';
    diceBtn.title = `Simulate 100 rolls within ${c.rarity} pool`;
    diceBtn.addEventListener('click', e => { e.stopPropagation(); showCatchRollPopup(c.rarity, e.currentTarget); });
    diceTd.appendChild(diceBtn); tr.appendChild(diceTd);
    tb.appendChild(tr);
  });
  catches.appendChild(t);
  const help = document.createElement('div'); help.className = 'help-text';
  help.textContent = 'Weight = relative chance within its rarity pool. Tokens = cashback on sell. Zone/Speed/Randomness/HP are per-catch overrides.';
  catches.appendChild(help);
}

function rebuildSelects() {
  const rodSel = $('sel-rod'); const baitSel = $('sel-bait');
  rodSel.innerHTML = ''; baitSel.innerHTML = '';
  CONFIG.rods.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id; opt.textContent = `${r.name} (${r.rarity})`;
    if (r.id === state.selectedRod) opt.selected = true;
    rodSel.appendChild(opt);
  });
  CONFIG.baits.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = `${b.name} (${b.rarity})`;
    if (b.id === state.selectedBait) opt.selected = true;
    baitSel.appendChild(opt);
  });

  const forceSel = $('sel-force-catch');
  const prevForce = forceSel.value;
  forceSel.innerHTML = '<option value="">— Random (use Bait) —</option>';
  CONFIG.catches.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = `${c.icon} ${c.name} (${c.rarity})`;
    if (c.id === prevForce) opt.selected = true;
    forceSel.appendChild(opt);
  });

  updateSelectedDisplay();
  updateForceCatchDisplay();
}

function updateForceCatchDisplay() {
  const forceSel = $('sel-force-catch');
  const val = forceSel ? forceSel.value : '';
  const nameEl = $('sel-force-name');
  const rarEl  = $('sel-force-rarity');
  if (!val) {
    nameEl.textContent = 'Random';
    rarEl.style.display = 'none';
    rarEl.className = 'rarity-tag';
  } else {
    const c = CONFIG.catches.find(x => x.id === val);
    if (c) {
      nameEl.textContent = c.name;
      rarEl.textContent  = c.rarity;
      rarEl.className    = `rarity-tag r-${c.rarity}`;
      rarEl.style.display = '';
    }
  }
}

function updateSelectedDisplay() {
  const r = getRod(); const b = getBait();
  $('sel-rod-name').textContent = r.name;
  $('sel-rod-rarity').textContent = r.rarity;
  $('sel-rod-rarity').className = 'rarity-tag r-' + r.rarity;
  $('sel-bait-name').textContent = b.name;
  $('sel-bait-rarity').textContent = b.rarity;
  $('sel-bait-rarity').className = 'rarity-tag r-' + b.rarity;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================
$('btn-cast').onclick = cast;
$('btn-reel').onclick = startReeling;
$('btn-stop').onclick = stop;
$('sel-rod').onchange = e => { state.selectedRod = e.target.value; updateSelectedDisplay(); };
$('sel-bait').onchange = e => { state.selectedBait = e.target.value; updateSelectedDisplay(); };
$('sel-force-catch').onchange = updateForceCatchDisplay;
$('chk-rod-immortal').onchange = e => { state.debugRodImmortal = e.target.checked; };
$('chk-catch-immortal').onchange = e => { state.debugCatchImmortal = e.target.checked; };

// Section collapse — persist open/closed state
function saveSectionStates() {
  const states = {};
  document.querySelectorAll('.debug-section[id]').forEach(sec => {
    states[sec.id] = sec.classList.contains('collapsed');
  });
  try { localStorage.setItem('fishingPondSections', JSON.stringify(states)); } catch(e) {}
}
function restoreSectionStates() {
  try {
    const saved = localStorage.getItem('fishingPondSections');
    if (!saved) return;
    const states = JSON.parse(saved);
    document.querySelectorAll('.debug-section[id]').forEach(sec => {
      if (sec.id in states) sec.classList.toggle('collapsed', states[sec.id]);
    });
  } catch(e) {}
}

document.querySelectorAll('.debug-section-header').forEach(h => {
  h.onclick = () => { h.parentElement.classList.toggle('collapsed'); saveSectionStates(); };
});

// Export / reset / import
$('btn-export').onclick = () => {
  $('export-text').value = JSON.stringify(CONFIG, null, 2);
  $('export-modal').classList.add('active');
};
$('btn-close-modal').onclick = () => $('export-modal').classList.remove('active');
$('btn-copy').onclick = () => {
  const ta = $('export-text'); ta.select(); document.execCommand('copy');
  $('btn-copy').textContent = 'Copied ✓';
  setTimeout(() => $('btn-copy').textContent = 'Copy to Clipboard', 1200);
};
$('btn-reset').onclick = () => {
  if (!confirm('Reset all config to defaults?')) return;
  CONFIG = structuredClone(DEFAULTS);
  localStorage.removeItem('fishingPondConfig');
  state.selectedRod = CONFIG.rods[0].id;
  state.selectedBait = CONFIG.baits[0].id;
  buildDebugUI();
  log('[Debug] Config reset to defaults.', 'info');
};
$('btn-clear-cache').onclick = () => {
  if (!confirm('Clear saved cache and reset to defaults?')) return;
  localStorage.removeItem('fishingPondConfig');
  CONFIG = structuredClone(DEFAULTS);
  state.selectedRod = CONFIG.rods[0].id;
  state.selectedBait = CONFIG.baits[0].id;
  buildDebugUI();
  log('[Debug] Cache cleared. Config reset to defaults.', 'info');
};

$('btn-import').onclick = () => {
  $('import-text').value = '';
  $('import-error').textContent = '';
  $('import-modal').classList.add('active');
};
$('btn-close-import-modal').onclick = () => $('import-modal').classList.remove('active');
$('btn-import-apply').onclick = () => {
  try {
    const parsed = JSON.parse($('import-text').value);
    CONFIG = structuredClone(parsed);
    state.selectedRod  = (CONFIG.rods[0] || {}).id  || state.selectedRod;
    state.selectedBait = (CONFIG.baits[0] || {}).id || state.selectedBait;
    saveConfig();
    buildDebugUI();
    $('import-modal').classList.remove('active');
    log('[Debug] Config imported from JSON.', 'info');
  } catch(e) {
    $('import-error').textContent = 'Invalid JSON: ' + e.message;
  }
};

// Debug controls
$('dbg-invincible').onchange = e => {
  state.debugInvincible = e.target.checked;
  $('invincible-badge').classList.toggle('visible', state.debugInvincible);
};
state.debugFreeCrank = localStorage.getItem('fishingPondFreeCrank') === 'true';
$('dbg-free-crank').checked = state.debugFreeCrank;
$('dbg-free-crank').onchange = e => {
  state.debugFreeCrank = e.target.checked;
  try { localStorage.setItem('fishingPondFreeCrank', e.target.checked); } catch(err) {}
};

// ============================================================================
// TOOLTIP — fixed-position, escapes scroll/overflow containers
// ============================================================================
(function() {
  const box = $('tooltip-box');
  let active = null;

  function show(el, e) {
    box.textContent = el.dataset.tip;
    box.style.display = 'block';
    position(e);
  }
  function hide() {
    box.style.display = 'none';
    active = null;
  }
  function position(e) {
    const pad = 12;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let x = e.clientX - bw - pad;
    let y = e.clientY - bh / 2;
    if (x < pad) x = e.clientX + pad;
    if (y < pad) y = pad;
    if (y + bh > window.innerHeight - pad) y = window.innerHeight - bh - pad;
    box.style.left = x + 'px';
    box.style.top  = y + 'px';
  }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('.tip');
    if (el && el.dataset.tip) { active = el; show(el, e); }
    else if (!e.target.closest('#tooltip-box')) hide();
  });
  document.addEventListener('mousemove', e => {
    if (active) position(e);
  });
  document.addEventListener('mouseout', e => {
    if (active && !active.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('scroll', hide, true);
})();

// ── Roll simulator ──────────────────────────────────────────────────────────
function simulateBaitRolls(bait, count) {
  const weights = bait.rarityWeights || {};
  const available = RARITIES.filter(r => (weights[r] ?? 0) > 0);
  const totalW = available.reduce((s, r) => s + weights[r], 0);
  const rarityCount = {};
  const catchCount  = {};
  for (let i = 0; i < count; i++) {
    let rv = Math.random() * totalW, picked = available[available.length - 1];
    for (const r of available) { rv -= weights[r]; if (rv <= 0) { picked = r; break; } }
    rarityCount[picked] = (rarityCount[picked] || 0) + 1;
    const pool = CONFIG.catches.filter(c => c.rarity === picked);
    if (!pool.length) continue;
    const pt = pool.reduce((s, c) => s + c.weight, 0);
    let cr = Math.random() * pt, pck = pool[pool.length - 1];
    for (const c of pool) { cr -= c.weight; if (cr <= 0) { pck = c; break; } }
    catchCount[pck.id] = (catchCount[pck.id] || 0) + 1;
  }
  return { rarityCount, catchCount };
}

function showCatchRollPopup(rarity, anchorEl) {
  const popup = $('roll-sim-popup');
  const key = `catch-${rarity}`;
  const isOpen = popup.classList.contains('visible') && popup.dataset.baitId === key;
  popup.classList.remove('visible');
  if (isOpen) return;
  const COUNT = 100;
  const pool = CONFIG.catches.filter(c => c.rarity === rarity);
  const total = pool.reduce((s, c) => s + c.weight, 0);
  const catchCount = {};
  for (let i = 0; i < COUNT; i++) {
    let r = Math.random() * total, picked = pool[pool.length - 1];
    for (const c of pool) { r -= c.weight; if (r <= 0) { picked = c; break; } }
    catchCount[picked.id] = (catchCount[picked.id] || 0) + 1;
  }
  let html = `<div class="roll-sim-head"><span class="rarity-tag r-${rarity}">${rarity}</span> · ${COUNT} ROLLS</div>`;
  pool.forEach(c => {
    const cc = catchCount[c.id] || 0;
    if (!cc) return;
    html += `<div class="roll-sim-row"><span>${c.icon} ${c.name}</span><span class="cnt">${cc}</span></div>`;
  });
  popup.innerHTML = html;
  popup.dataset.baitId = key;
  popup.style.top = '-9999px'; popup.style.left = '-9999px';
  popup.classList.add('visible');
  const rect = anchorEl.getBoundingClientRect();
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  let left = rect.left, top = rect.bottom + 6;
  if (left + pw > window.innerWidth  - 8) left = window.innerWidth  - pw - 8;
  if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 6;
  if (left < 8) left = 8;
  if (top  < 8) top  = 8;
  popup.style.left = left + 'px'; popup.style.top = top + 'px';
}

function showRollPopup(bait, anchorEl) {
  const popup = $('roll-sim-popup');
  const isOpen = popup.classList.contains('visible') && popup.dataset.baitId === bait.id;
  popup.classList.remove('visible');
  if (isOpen) return;
  const COUNT = 100;
  const { rarityCount, catchCount } = simulateBaitRolls(bait, COUNT);
  let html = `<div class="roll-sim-head">${bait.name.toUpperCase()} · ${COUNT} ROLLS</div>`;
  RARITIES.forEach(r => {
    const rc = rarityCount[r] || 0;
    if (!rc) return;
    html += `<div class="roll-sim-rarity"><span class="rarity-tag r-${r}">${r}</span><span class="roll-sim-rarity-pct">${rc}/${COUNT}</span></div>`;
    CONFIG.catches.filter(c => c.rarity === r).forEach(c => {
      const cc = catchCount[c.id] || 0;
      if (!cc) return;
      html += `<div class="roll-sim-row"><span>${c.icon} ${c.name}</span><span class="cnt">${cc}</span></div>`;
    });
  });
  popup.innerHTML = html;
  popup.dataset.baitId = bait.id;
  // Position: show offscreen first to measure, then clamp to viewport
  popup.style.top  = '-9999px';
  popup.style.left = '-9999px';
  popup.classList.add('visible');
  const rect = anchorEl.getBoundingClientRect();
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let left = rect.left;
  let top  = rect.bottom + 6;
  if (left + pw > window.innerWidth  - 8) left = window.innerWidth  - pw - 8;
  if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 6;
  if (left < 8) left = 8;
  if (top  < 8) top  = 8;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';
}
document.addEventListener('click', () => { const p = $('roll-sim-popup'); if (p) p.classList.remove('visible'); });

// ============================================================================
// BOOT
// ============================================================================
async function init() {
  // Fetch defaults from data.json
  DEFAULTS = await fetch('./data.json').then(r => r.json());
  CONFIG = structuredClone(DEFAULTS);

  // Load and migrate saved config from localStorage if present
  try {
    const saved = localStorage.getItem('fishingPondConfig');
    if (saved) {
      CONFIG = migrateConfig(JSON.parse(saved));
      saveConfig();
      log('[Debug] Config loaded from local cache.', 'info');
    }
  } catch(e) {}

  buildDebugUI();
  restoreSectionStates();
  updateStats();

  // Draw static tick marks on reel circumference (outer ring, above dark fill)
  (function drawReelTicks() {
    const svg = $('reel-svg');
    const crankG = $('crank-g');
    const cx = 130, cy = 130;
    const count = Math.round(360 / CRANK_DEG_PER_TICK);
    const degPerMajor = CRANK_DEG_PER_10PCT;
    for (let i = 0; i < count; i++) {
      const deg = i * CRANK_DEG_PER_TICK;
      const isMajor = deg % degPerMajor === 0;
      const r1 = isMajor ? 110 : 113;
      const r2 = 124;
      const rad = (deg - 90) * Math.PI / 180;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx + r1 * Math.cos(rad));
      line.setAttribute('y1', cy + r1 * Math.sin(rad));
      line.setAttribute('x2', cx + r2 * Math.cos(rad));
      line.setAttribute('y2', cy + r2 * Math.sin(rad));
      line.setAttribute('stroke', isMajor ? '#5a7a9a' : '#3a5068');
      line.setAttribute('stroke-width', isMajor ? '2' : '1.5');
      line.setAttribute('stroke-linecap', 'round');
      svg.insertBefore(line, crankG);
    }
  })();

  setPhase('idle');
  log('Welcome! Press SPACE to cast, then alternate ← → to reel.', 'info');
  log('Open CATCH POOL on the right to tune individual fish stats.', 'info');
  requestAnimationFrame(tick);
}

init();
