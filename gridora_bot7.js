// bot.js
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { SignJWT } from 'jose';

/* =======================
   LOGGING UTILITIES
   ======================= */
const LOG_REDACT_SECRETS = true;
const LOG_MAX_CHARS = 20000;

const originalFetch = globalThis.fetch;

function ellipsize(s) {
  if (s == null) return String(s);
  const str = String(s);
  if (str.length <= LOG_MAX_CHARS) return str;
  return str.slice(0, LOG_MAX_CHARS) + ` �[+${str.length - LOG_MAX_CHARS} chars]`;
}
function mask(str, keepStart = 6, keepEnd = 2) {
  if (!str) return str;
  const s = String(str);
  if (s.length <= keepStart + keepEnd) return '*'.repeat(Math.max(4, s.length));
  return s.slice(0, keepStart) + '�' + '*'.repeat(8) + '�' + s.slice(-keepEnd);
}
function redactHeaders(h) {
  if (!LOG_REDACT_SECRETS || !h) return h;
  const out = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (['authorization', 'apikey', 'x-api-key'].includes(key)) out[k] = mask(String(v));
    else out[k] = String(v);
  }
  return out;
}
function redactBody(bodyStr) {
  if (!LOG_REDACT_SECRETS || !bodyStr) return bodyStr;
  try {
    const obj = JSON.parse(bodyStr);
    const scrub = (o) => {
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const lc = k.toLowerCase();
          if (['password', 'access_token', 'refresh_token', 'token', 'jwt', 'api_key', 'apikey', 'secret'].includes(lc)) {
            o[k] = mask(String(o[k]));
          } else if (typeof o[k] === 'object') {
            scrub(o[k]);
          }
        }
      }
    };
    scrub(obj);
    return JSON.stringify(obj);
  } catch {
    return bodyStr
      .replace(/(access_token|refresh_token|token|jwt|api_key|apikey|secret)"?\s*:\s*"([^"]+)"/gi, (_m, k, v) => `${k}:"${mask(v)}"`)
      .replace(/(Bearer\s+)([A-Za-z0-9\.\-\_=]+)/gi, (_m, p1, p2) => p1 + mask(p2));
  }
}
function sanitizeUrl(url) {
  if (!LOG_REDACT_SECRETS) return url;
  try {
    const u = new URL(url);
    for (const p of ['jwt', 'api_key', 'apikey']) {
      if (u.searchParams.has(p)) u.searchParams.set(p, mask(u.searchParams.get(p)));
    }
    return u.toString();
  } catch {
    return url;
  }
}
async function loggedFetch(url, options = {}) {
  const method = options.method || 'GET';
  let bodyStr = '';
  if (options.body != null) {
    bodyStr = typeof options.body === 'string' ? options.body : (() => {
      try { return JSON.stringify(options.body); } catch { return String(options.body); }
    })();
  }
  console.log(
    '??  HTTP REQUEST:',
    method,
    sanitizeUrl(String(url)),
    '\nHeaders:', redactHeaders(options.headers || {}),
    '\nBody:', ellipsize(redactBody(bodyStr))
  );
  const res = await originalFetch(url, options);
  const clone = res.clone();
  let text = '';
  try { text = await clone.text(); } catch { text = '[non-text body]'; }
  console.log(
    '??  HTTP RESPONSE:',
    res.status, res.statusText, 'from', sanitizeUrl(String(url)),
    '\nBody:', ellipsize(redactBody(text))
  );
  return res;
}
globalThis.fetch = loggedFetch;

/* =======================
   CONFIG
   ======================= */
const SUPABASE_URL = "https://pvhtheidiovgdkxiqoaj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2aHRoZWlkaW92Z2RreGlxb2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYxMTE1MTksImV4cCI6MjA2MTY4NzUxOX0.XWJrvn1D_9jteRF4rfFq7LKrasarWCH22dNtjNbY7tk";

const PIESOCKET_INSTANCE_ID = "s14871.blr1";
const PIESOCKET_API_KEY = "GXU7TnLz0aNJFWXXyCF6l0CYBMJ5CdbF4tuY8Oed";
const PIESOCKET_APP_SECRET = "";

/* =======================
   TIMING
   ======================= */
const START_TURN_DELAY_MS = 2000;
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/* =======================
   STATE
   ======================= */
const state = {
  isHost: false,
  ws: /** @type {WebSocket|null} */(null),

  matchId: null,
  deck: /** @type {string[]} */([]),
  deckPtr: 0,                 // draw from END
  community: /** @type {string[]} */([]),

  myGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),
  oppGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),

  myPlaced: 0,
  oppPlaced: 0,

  myTurn: false,
  turnOwner: 'me',            // 'me' | 'opp'
  turnPlacements: 0,
  requiredThisTurn: 0,        // snapshot at beginTurn()
  myPlacedAtTurnStart: 0,
  oppPlacedAtTurnStart: 0,

  matchStatus: null,
  opponentId: null,

  gameStarted: false,
  gameOver: false,

  // buffer opponent placements that arrive while it's not their turn
  oppBufferedPlacements: 0,

  // guard to avoid duplicate/overlapping refills
  isRefilling: false,
};

/* =======================
   INSIGHT / DEBUG PRINTS
   ======================= */
const TOTAL_ROUNDS = Math.ceil((25 * 2) / 4); // 13

function gridToString(grid) {
  const show = (v) => (v == null ? '..' : String(v)).padEnd(3, ' ');
  return grid.map(row => row.map(show).join(' ')).join('\n');
}
function currentRoundInfo() {
  const totalPlaced = state.myPlaced + state.oppPlaced; // across both players
  const completedRounds = Math.floor(totalPlaced / 4);
  let round = completedRounds + 1;
  if (round > TOTAL_ROUNDS) round = TOTAL_ROUNDS;

  const plannedThisRound = (round < TOTAL_ROUNDS) ? 4 : 2;
  let placedThisRound = totalPlaced - completedRounds * 4;
  if (round === TOTAL_ROUNDS) placedThisRound = Math.min(placedThisRound, 2);
  const roundRemaining = Math.max(0, plannedThisRound - placedThisRound);

  return { round, plannedThisRound, placedThisRound, roundRemaining, totalPlaced };
}
function turnsRemaining(placed) {
  const rem = Math.max(0, 25 - placed);
  return Math.ceil(rem / 2);
}
function logGameState(reason = '') {
  const { round, plannedThisRound, placedThisRound, roundRemaining, totalPlaced } = currentRoundInfo();
  const thisTurnReq = state.requiredThisTurn;
  const thisTurnRem = Math.max(0, thisTurnReq - state.turnPlacements);
  const myTurnsRem = turnsRemaining(state.myPlaced);
  const oppTurnsRem = turnsRemaining(state.oppPlaced);

  console.log(
`================= ?? STATE ${reason ? `(${reason})` : ''} =================
Round: ${round}/${TOTAL_ROUNDS} | This Round: placed ${placedThisRound}/${plannedThisRound} | Round remaining cards: ${roundRemaining}
Overall placed: my ${state.myPlaced}/25, opp ${state.oppPlaced}/25 (total ${totalPlaced}/50)
Turn: owner=${state.turnOwner} | placed this turn=${state.turnPlacements}/${thisTurnReq} | this turn remaining=${thisTurnRem}
Turns remaining: my ${myTurnsRem}, opp ${oppTurnsRem}
Deck remaining: ${state.deckPtr} | Community (${state.community.length}): [${state.community.join(' ')}]

My Grid:
${gridToString(state.myGrid)}

Opp Grid:
${gridToString(state.oppGrid)}
==================================================================`
  );
}

/* =======================
   UTIL
   ======================= */
// Kept as fallback only � primary path uses matchmaking token
async function createJwtForRoom(room) {
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  const iat = now - skew;
  const nbf = now - skew;
  const exp = now + 60 * 10;
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setNotBefore(nbf)
    .setExpirationTime(exp)
    .setSubject(room)
    .sign(new TextEncoder().encode(PIESOCKET_APP_SECRET));
}
function parseDeckString(deckStr) {
  return String(deckStr).trim().split(/\s+/).filter(Boolean);
}
function randomInt(n) {
  return Math.floor(Math.random() * n);
}
function drawFromDeck(count) { // draw from END
  const take = Math.min(count, state.deckPtr);
  const start = state.deckPtr - take;
  const drawn = state.deck.slice(start, state.deckPtr);
  state.deckPtr = start;
  return drawn;
}
function initCommunity() {
  state.community = drawFromDeck(7);
  console.log("?? Initial community:", state.community);
  logGameState('initCommunity');
}

/* =======================
   GAME OVER / PASS HELPERS
   ======================= */
function isGameOver() {
  return state.myPlaced >= 25 && state.oppPlaced >= 25;
}
function finishGame(reason = 'all cards placed') {
  if (state.gameOver) return;
  state.gameOver = true;
  console.log(`?? GAME OVER (${reason})`);
  logGameState('game_over');
  // Optional: state.ws?.close();
}

/* =======================
   TURN MGMT
   ======================= */
function pickRandomEmptyCell(grid) {
  const empties = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (grid[r][c] === null) empties.push([r, c]);
  }
  if (empties.length === 0) return null;
  return empties[randomInt(empties.length)];
}
function removeCardFromCommunity(card) {
  const idx = state.community.indexOf(card);
  if (idx >= 0) state.community.splice(idx, 1);
}
function sendPlaceCard(ws, card, row, col) {
  const opponent_time = 100 + randomInt(300);
  const payload = {
    c2dictionary: true,
    data: { type: "place_card", card, col, row, opponent_time }
  };
  ws.send(JSON.stringify(payload)); // ws wrapper logs this
}

function computeRequiredForStart(owner) {
  const placedAtStart = (owner === 'me') ? state.myPlaced : state.oppPlaced;
  const remaining = 25 - placedAtStart;
  return Math.min(2, Math.max(0, remaining));
}

async function onOpponentPlacedOne(card, row, col) {
  if (state.gameOver) return;

  // reflect board/community immediately
  if (row >= 0 && row < 5 && col >= 0 && col < 5) state.oppGrid[row][col] = card;
  removeCardFromCommunity(card);
  state.oppPlaced += 1;

  if (isGameOver()) { finishGame('opponent finished'); return; }

  if (state.turnOwner === 'opp') {
    state.turnPlacements += 1;
    logGameState(`opp placed ${card} @ r${row},c${col}`);
    if (state.turnPlacements >= state.requiredThisTurn && state.requiredThisTurn > 0) {
      await endTurnAndRefillSafe();
    }
  } else {
    state.oppBufferedPlacements += 1;
    logGameState(`opp placed (buffered) ${card} @ r${row},c${col}`);
  }
}

function beginTurn(owner) {
  if (state.gameOver) return;

  state.turnOwner = owner;
  state.turnPlacements = 0;
  state.requiredThisTurn = computeRequiredForStart(owner);

  if (owner === 'me') {
    state.myPlacedAtTurnStart = state.myPlaced;
  } else {
    // Opp turn: apply buffered moves into this turn immediately
    state.oppPlacedAtTurnStart = state.oppPlaced - state.oppBufferedPlacements;
    if (state.oppBufferedPlacements > 0) {
      state.turnPlacements = state.oppBufferedPlacements;
      state.oppBufferedPlacements = 0;
    }
  }

  state.myTurn = (owner === 'me');
  console.log(state.myTurn ? "?? Our turn" : "?? Opponent's turn");
  logGameState('beginTurn');

  // If game already complete, finish.
  if (isGameOver()) { finishGame('all cards placed at turn start'); return; }

  // If this player has *no moves* (requiredThisTurn === 0), immediately pass.
  if (state.requiredThisTurn === 0) {
    setTimeout(() => { if (!state.gameOver) void endTurnAndRefillSafe(); }, 0);
    return;
  }

  // If buffered moves already complete their requirement, end immediately.
  if (state.turnPlacements >= state.requiredThisTurn && owner === 'opp') {
    setTimeout(() => { if (!state.gameOver) void endTurnAndRefillSafe(); }, 0);
  }
}

// Async, guarded, and auto-starts our turn if we become the owner.
async function endTurnAndRefillSafe() {
  if (state.gameOver || state.isRefilling) return;
  state.isRefilling = true;

  const toDraw = state.turnPlacements; // freeze
  if (toDraw > 0) {
    const drawn = drawFromDeck(toDraw);
    state.community.push(...drawn);
    console.log(`?? Drew ${drawn.length} replacement(s):`, drawn, "? community:", state.community);
  }

  // Flip owner
  const nextOwner = (state.turnOwner === 'me') ? 'opp' : 'me';
  beginTurn(nextOwner);

  state.isRefilling = false;

  // If it's now our turn and we do have required moves, start playing
  if (!state.gameOver && state.myTurn && state.requiredThisTurn > 0) {
    await sleep(300 + randomInt(400));
    await playMyTurn();
  }
}

/* =======================
   BOT ACTIONS
   ======================= */
function botPlaceOne() {
  if (!state.ws || state.gameOver) return false;
  if (state.community.length === 0) { console.warn("No community cards available to place."); return false; }

  const cell = pickRandomEmptyCell(state.myGrid);
  if (!cell) { console.warn("No empty cell available on our grid."); return false; }
  const [row, col] = cell;
  const card = state.community[randomInt(state.community.length)];

  state.myGrid[row][col] = card;
  removeCardFromCommunity(card);
  sendPlaceCard(state.ws, card, row, col);
  state.turnPlacements += 1;
  state.myPlaced += 1;

  logGameState(`bot placed ${card} @ r${row},c${col}`);

  if (isGameOver()) { finishGame('bot finished'); return false; }
  return true;
}

async function playMyTurn() {
  if (!state.ws || !state.myTurn || state.gameOver) return;
  const need = state.requiredThisTurn; // snapshot for this turn
  if (need === 0) return;

  console.log(`?? Our turn: need to place ${need} card(s).`);
  let placed = 0;
  for (let i = 0; i < need; i++) {
    const ok = botPlaceOne();
    if (!ok) break;
    placed += 1;
    if (state.gameOver) break;
    await sleep(300 + randomInt(500));
  }
  if (!state.gameOver && placed < need) {
    console.warn(`?? Could not complete required placements (needed ${need}, placed ${placed}).`);
  }
  if (!state.gameOver) await endTurnAndRefillSafe(); // draw and flip
}

/* =======================
   RPC: ready + store deck/match
   ======================= */
async function confirmReadyAndStore(JWT_TOKEN, matchId) {
  const readyRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pg_player_ready`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${JWT_TOKEN}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify({ p_match_id: String(matchId) })
  });
  if (!readyRes.ok) {
    console.error("? Failed to confirm ready:", await readyRes.text());
    return null;
  }
  let payload;
  try { payload = await readyRes.json(); } catch { payload = null; }
  const data = (payload && payload.data) ? payload.data :
               (Array.isArray(payload) && payload[0]) || payload || {};
  state.matchId = Number(data.match_id ?? matchId);
  state.deck = parseDeckString(data.shuffled_deck || "");
  state.deckPtr = state.deck.length; // draw from END
  state.matchStatus = data.match_status || null;
  state.opponentId = data.opponent_id || null;

  console.log("?? Stored match/deck:", {
    matchId: state.matchId,
    deckCount: state.deck.length,
    last7: state.deck.slice(Math.max(0, state.deck.length - 7))
  });

  // If backend reports in_progress, trigger game_started once
  if (
    state.matchStatus === "in_progress" &&
    !state.gameStarted &&
    state.ws &&
    state.ws.readyState === WebSocket.OPEN
  ) {
    const startPayload = { c2dictionary: true, data: { type: "game_started" } };
    state.ws.send(JSON.stringify(startPayload));
    console.log("?? Sent game_started (backend reported in_progress).");
          if (state.gameStarted) return;          // guard duplicate starts
      state.gameStarted = true;
      console.log("?? GAME STARTED");

      initCommunity();                         // initial 7
      beginTurn(state.isHost ? 'me' : 'opp');

      if (state.myTurn && state.requiredThisTurn > 0) {
        await sleep(START_TURN_DELAY_MS);
        await playMyTurn();
      }
      return;
  }

  return data;
}

/* =======================
   MAIN
   ======================= */
async function runBot(email, password) {
  console.log(`?? Starting Gridora bot for ${email}...`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: loggedFetch } });
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) { console.error("? Authentication failed:", authError.message); return; }
  const JWT_TOKEN = authData.session.access_token;
  console.log("? Authenticated.");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/matchmaking`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${JWT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const matchResp = await res.json();
  console.log("?? Matchmaking response:", matchResp);
  if (!matchResp.success) { console.error("? Matchmaking failed:", matchResp.error); return; }

  const { room, match_id, player1_nickname, player2_nickname } = matchResp.data;
  state.isHost = (match_id === null);
  const matchId = match_id || parseInt(room.split("_").pop());

  // Use token provided by matchmaking; fallback to local JWT if missing
  const wsJwt = matchResp.token || await createJwtForRoom(room);
  const wsUrl = `wss://${PIESOCKET_INSTANCE_ID}.piesocket.com/v3/${room}?api_key=${PIESOCKET_API_KEY}&jwt=${wsJwt}`;
  console.log('?? WS CONNECT:', sanitizeUrl(wsUrl));

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  // Single-source WS send logging
  const rawSend = ws.send;
  ws.send = function (data, ...args) {
    const outStr = typeof data === 'string' ? data
      : Buffer.isBuffer(data) ? data.toString('utf8')
      : (() => { try { return JSON.stringify(data); } catch { return String(data); } })();
    console.log('?? WS SEND:', ellipsize(outStr));
    return rawSend.call(ws, data, ...args);
  };

  ws.on('open', async () => {
    console.log("?? WebSocket connected to room:", room);
    if (state.isHost) {
      console.log("?? Host: waiting for opponent...");
    } else {
      const joinPayload = {
        c2dictionary: true,
        data: {
          type: "opponent_joined",
          match_id: matchId,
          opponent_nickname: player2_nickname,
          opponent_rating: "1000",
          opponent_country: "BRAZIL"
        }
      };
      ws.send(JSON.stringify(joinPayload));
      console.log("?? Sent opponent_joined payload.");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
    }
  });

  ws.on('message', async (buf) => {
    const text = buf.toString();
    console.log("?? WS RECV:", ellipsize(text));

    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || !msg.c2dictionary || !msg.data || !msg.data.type) return;

    const type = msg.data.type;

    if (state.isHost && type === "opponent_joined") {
      console.log("?? Opponent joined. Confirming ready...");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
      return;
    }

    if (type === "game_started") {
      if (state.gameStarted) return;          // guard duplicate starts
      state.gameStarted = true;
      console.log("?? GAME STARTED");

      initCommunity();                         // initial 7
      beginTurn(state.isHost ? 'me' : 'opp');

      if (state.myTurn && state.requiredThisTurn > 0) {
        await sleep(START_TURN_DELAY_MS);
        await playMyTurn();
      }
      return;
    }

    if (type === "activate_card") {
      // ignore per requirement
      return;
    }

    if (type === "place_card") {
      const { card, row, col } = msg.data;
      console.log(`?? Opponent placed ${card} at r${row},c${col}`);
      await onOpponentPlacedOne(String(card), Number(row), Number(col)); // await to keep order
      return;
    }
  });

  ws.on('close', () => console.log("?? WebSocket closed."));
  ws.on('error', (err) => console.error("?? WebSocket error:", err.message));
}

/* =======================
   ENTRY
   ======================= */
if (process.argv.length < 4) {
  console.log("Usage: node bot.js <email> <password>");
  process.exit(1);
}
const email = process.argv[2];
const password = process.argv[3];
runBot(email, password);