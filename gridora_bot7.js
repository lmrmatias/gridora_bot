/* 

    bot.js by Luimati (fixed)
    V1.4
    August 2025

*/

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { SignJWT } from 'jose';

const originalFetch = globalThis.fetch;

const SUPABASE_URL = "https://pvhtheidiovgdkxiqoaj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2aHRoZWlkaW92Z2RreGlxb2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYxMTE1MTksImV4cCI6MjA2MTY4NzUxOX0.XWJrvn1D_9jteRF4rfFq7LKrasarWCH22dNtjNbY7tk";
const PIESOCKET_INSTANCE_ID = "s14871.blr1";
const PIESOCKET_API_KEY = "GXU7TnLz0aNJFWXXyCF6l0CYBMJ5CdbF4tuY8Oed";

const START_TURN_DELAY_MS = 2000;
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const TOTAL_ROUNDS = 13;
const COMMUNITY_TARGET = 7; // Always try to maintain 7 community cards while deck has cards

const parseDeckString = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const randomInt = (n) => Math.floor(Math.random() * n);

// Tracks any card that has been placed on either grid so refills skip them
const consumedCards = new Set();

const state = {
  isHost: false,
  ws: /** @type {WebSocket|null} */ (null),

  matchId: null,
  deck: /** @type {string[]} */ ([]),
  deckPtr: 0,
  community: /** @type {string[]} */ ([]),

  myGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),
  oppGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),

  myPlaced: 0,
  oppPlaced: 0,

  myTurn: false,
  turnOwner: 'me',
  turnPlacements: 0,
  requiredThisTurn: 0,
  myPlacedAtTurnStart: 0,
  oppPlacedAtTurnStart: 0,

  matchStatus: null,
  opponentId: null,

  gameStarted: false,
  gameOver: false,

  oppBufferedPlacements: 0,
  isRefilling: false,
};

async function loggedFetch(url, options = {}) {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  let bodyStr = '';
  if (options.body != null) {
    if (typeof options.body === 'string') bodyStr = options.body;
    else {
      try { bodyStr = JSON.stringify(options.body); }
      catch { bodyStr = String(options.body); }
    }
  }

  console.log('  HTTP REQUEST:', method, String(url), '\nHeaders:', headers, '\nBody:', bodyStr);
  const res = await originalFetch(url, options);
  const clone = res.clone();
  let text = '';
  try { text = await clone.text(); }
  catch { text = '[non-text body]'; }
  console.log('  HTTP RESPONSE:', res.status, res.statusText, 'from', String(url), '\nBody:', text);
  return res;
}
globalThis.fetch = loggedFetch;

function gridToString(grid) {
  const show = (v) => (v == null ? '..' : String(v)).padEnd(3, ' ');
  return grid.map(row => row.map(show).join(' ')).join('\n');
}

function currentRoundInfo() {
  const totalPlaced = state.myPlaced + state.oppPlaced;
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

  console.log("====================================");
  console.log(` STATE ${reason ? `(${reason})` : ""}`);
  console.log("------------------------------------");
  console.log(`Round: ${round}/${TOTAL_ROUNDS}`);
  console.log(`This Round: placed ${placedThisRound}/${plannedThisRound} | Remaining cards: ${roundRemaining}`);
  console.log(`Overall placed: my ${state.myPlaced}/25, opp ${state.oppPlaced}/25 (total ${totalPlaced}/50)`);
  console.log(`Turn: owner=${state.turnOwner} | placed this turn=${state.turnPlacements}/${thisTurnReq} | remaining=${thisTurnRem}`);
  console.log(`Turns remaining: my ${myTurnsRem}, opp ${oppTurnsRem}`);
  console.log(`Deck remaining: ${state.deckPtr} | Community (${state.community.length}): [${state.community.join(" ")}]`);

  console.log("\nMy Grid:");
  console.log(gridToString(state.myGrid));

  console.log("\nOpp Grid:");
  console.log(gridToString(state.oppGrid));

  console.log("====================================");
}

/** Draw from the top (end) of state.deck, skipping any already-consumed cards */
function drawFromDeck(count) {
  const drawn = [];
  while (drawn.length < count && state.deckPtr > 0) {
    const next = state.deck[state.deckPtr - 1];
    state.deckPtr -= 1;
    // Skip cards that were already placed (by anyone)
    if (consumedCards.has(next)) continue;
    drawn.push(next);
  }
  return drawn;
}

function initCommunity() {
  state.community = drawFromDeck(COMMUNITY_TARGET);
  console.log(" Initial community:", state.community);
  logGameState('initCommunity');
}

/* =======================
   GAME OVER / PASS
   ======================= */
const isGameOver = () => state.myPlaced >= 25 && state.oppPlaced >= 25;

function finishGame(reason = 'all cards placed') {
  if (state.gameOver) return;
  state.gameOver = true;
  console.log(` GAME OVER (${reason})`);
  logGameState('game_over');
}

function pickRandomEmptyCell(grid) {
  const empties = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++) {
      if (grid[r][c] === null) empties.push([r, c]);
    }
  return empties.length ? empties[randomInt(empties.length)] : null;
}

function removeCardFromCommunity(card) {
  const idx = state.community.indexOf(card);
  if (idx >= 0) {
    state.community.splice(idx, 1);
    return true;
  }
  return false;
}

function sendPlaceCard(ws, card, row, col) {
  const opponent_time = 100 + randomInt(30);
  ws.send(JSON.stringify({
    c2dictionary: true,
    data: { type: "place_card", card, col, row, opponent_time }
  }));
}

function computeRequiredForStart(owner) {
  const placedAtStart = (owner === 'me') ? state.myPlaced : state.oppPlaced;
  return Math.min(2, Math.max(0, 25 - placedAtStart));
}

async function onOpponentPlacedOne(card, row, col) {
  if (state.gameOver) return;

  // Mark as consumed BEFORE any potential refill
  consumedCards.add(card);

  if (row >= 0 && row < 5 && col >= 0 && col < 5) state.oppGrid[row][col] = card;

  // Remove from community (affects top-up at end of turn)
  removeCardFromCommunity(card);
  state.oppPlaced += 1;

  if (isGameOver()) {
    finishGame('opponent finished');
    return;
  }

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
    state.oppPlacedAtTurnStart = state.oppPlaced - state.oppBufferedPlacements;
    if (state.oppBufferedPlacements > 0) {
      state.turnPlacements = state.oppBufferedPlacements;
      state.oppBufferedPlacements = 0;
    }
  }

  state.myTurn = (owner === 'me');
  console.log(state.myTurn ? " Our turn" : " Opponent's turn");
  logGameState('beginTurn');

  if (isGameOver()) {
    finishGame('all cards placed at turn start');
    return;
  }
  if (state.requiredThisTurn === 0) {
    setTimeout(() => {
      if (!state.gameOver) void endTurnAndRefillSafe();
    }, 0);
    return;
  }
  if (state.turnPlacements >= state.requiredThisTurn && owner === 'opp') {
    setTimeout(() => {
      if (!state.gameOver) void endTurnAndRefillSafe();
    }, 0);
  }
}

async function endTurnAndRefillSafe() {
  if (state.gameOver || state.isRefilling) return;
  state.isRefilling = true;

  // Always top up to COMMUNITY_TARGET while deck has cards (skips consumed internally)
  const want = Math.max(0, COMMUNITY_TARGET - state.community.length);
  const can = Math.min(want, state.deckPtr);
  if (can > 0) {
    const drawn = drawFromDeck(can);
    if (drawn.length) {
      state.community.push(...drawn);
      console.log(` Refilled community by ${drawn.length}:`, drawn, "? community:", state.community);
    } else {
      console.log(` Refill attempted but no non-consumed cards available (want ${want}, deckPtr ${state.deckPtr}).`);
    }
  } else {
    console.log(` No refill possible (want ${want}, deckPtr ${state.deckPtr}).`);
  }

  const nextOwner = (state.turnOwner === 'me') ? 'opp' : 'me';
  beginTurn(nextOwner);

  state.isRefilling = false;

  if (!state.gameOver && state.myTurn && state.requiredThisTurn > 0) {
    await sleep(1000 + randomInt(700));
    await playMyTurn();
  }
}

/* =======================
   BOT ACTIONS
   ======================= */
function botPlaceOne() {
  if (!state.ws || state.gameOver) return false;
  if (state.community.length === 0) {
    console.warn("No community cards available to place.");
    return false;
  }

  const cell = pickRandomEmptyCell(state.myGrid);
  if (!cell) {
    console.warn("No empty cell available on our grid.");
    return false;
  }
  const [row, col] = cell;
  const card = state.community[randomInt(state.community.length)];

  state.myGrid[row][col] = card;

  // Mark as consumed and remove from community so it can never be re-dealt
  consumedCards.add(card);
  removeCardFromCommunity(card);

  sendPlaceCard(state.ws, card, row, col);
  state.turnPlacements += 1;
  state.myPlaced += 1;

  logGameState(`bot placed ${card} @ r${row},c${col}`);

  if (isGameOver()) {
    finishGame('bot finished');
    return false;
  }
  return true;
}

async function playMyTurn() {
  if (!state.ws || !state.myTurn || state.gameOver) return;
  const need = state.requiredThisTurn;
  if (need === 0) return;

  console.log(` Our turn: need to place ${need} card(s).`);
  let placed = 0;
  for (let i = 0; i < need; i++) {
    const ok = botPlaceOne();
    if (!ok) break;
    placed += 1;
    if (state.gameOver) break;
    await sleep(300 + randomInt(500));
  }
  if (!state.gameOver && placed < need) {
    console.warn(` Could not complete required placements (needed ${need}, placed ${placed}).`);
  }
  if (!state.gameOver) await endTurnAndRefillSafe();
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
  state.deckPtr = state.deck.length;
  state.matchStatus = data.match_status || null;
  state.opponentId = data.opponent_id || null;

  console.log(" Stored match/deck:", {
    matchId: state.matchId,
    deckCount: state.deck.length,
    last7: state.deck.slice(Math.max(0, state.deck.length - 7))
  });

  if (
    state.matchStatus === "in_progress" &&
    !state.gameStarted &&
    state.ws &&
    state.ws.readyState === WebSocket.OPEN
  ) {
    const startPayload = { c2dictionary: true, data: { type: "game_started" } };
    state.ws.send(JSON.stringify(startPayload));
    console.log(" Sent game_started (backend reported in_progress).");
    if (state.gameStarted) return;
    state.gameStarted = true;
    console.log(" GAME STARTED");

    initCommunity();
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
  console.log(` Starting Gridora bot for ${email}...`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: loggedFetch } });
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) {
    console.error("? Authentication failed:", authError.message);
    return;
  }
  const JWT_TOKEN = authData.session.access_token;
  console.log("? Authenticated.");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/matchmaking`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${JWT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const matchResp = await res.json();
  console.log(" Matchmaking response:", matchResp);
  if (!matchResp.success) {
    console.error("? Matchmaking failed:", matchResp.error);
    return;
  }

  const { room, match_id, player1_nickname, player2_nickname } = matchResp.data;
  state.isHost = (match_id === null);
  const matchId = match_id || parseInt(room.split("_").pop());

  const wsJwt = matchResp.token || await createJwtForRoom(room);
  const wsUrl = `wss://${PIESOCKET_INSTANCE_ID}.piesocket.com/v3/${room}?api_key=${PIESOCKET_API_KEY}&jwt=${wsJwt}`;
  console.log(' WS CONNECT:', wsUrl);

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  const rawSend = ws.send;
  ws.send = function(data, ...args) {
    const outStr = typeof data === 'string' ? data :
      Buffer.isBuffer(data) ? data.toString('utf8') :
      (() => { try { return JSON.stringify(data); } catch { return String(data); } })();
    console.log(' WS SEND:', outStr);
    return rawSend.call(ws, data, ...args);
  };

  ws.on('open', async () => {
    console.log(" WebSocket connected to room:", room);
    if (state.isHost) {
      console.log(" Host: waiting for opponent...");
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
      console.log(" Sent opponent_joined payload.");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
    }
  });

  ws.on('message', async (buf) => {
    const text = buf.toString();
    console.log(" WS RECV:", text);

    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || !msg.c2dictionary || !msg.data || !msg.data.type) return;

    const type = msg.data.type;

    if (state.isHost && type === "opponent_joined") {
      console.log(" Opponent joined. Confirming ready...");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
      return;
    }

    if (type === "game_started") {
      if (state.gameStarted) return;
      state.gameStarted = true;
      console.log(" GAME STARTED");

      initCommunity();
      beginTurn(state.isHost ? 'me' : 'opp');

      if (state.myTurn && state.requiredThisTurn > 0) {
        await sleep(START_TURN_DELAY_MS);
        await playMyTurn();
      }
      return;
    }

    if (type === "activate_card") return;

    if (type === "place_card") {
      const { card, row, col } = msg.data;
      console.log(` Opponent placed ${card} at r${row},c${col}`);
      await onOpponentPlacedOne(String(card), Number(row), Number(col));
      return;
    }
  });

  ws.on('close', () => console.log(" WebSocket closed."));
  ws.on('error', (err) => console.error(" WebSocket error:", err.message));
}

/* =======================
   JWT helper (unchanged placeholder; implement if needed)
   ======================= */
async function createJwtForRoom(room) {
  // NOTE: Replace with your real signing key if required by your infra.
  // Here we just build a short-lived unsigned token if your PieSocket config allows;
  // otherwise wire up SignJWT with your secret.
  return new SignJWT({ room })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode('replace-with-your-secret'));
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
