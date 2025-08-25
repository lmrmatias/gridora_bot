// improve_bot.js
// This file integrates the "MCTS Champion" bot logic into the original game client.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { SignJWT } from 'jose';


// ===================================================================================
// === ALL NEW "CHAMPION" BOT CODE ADDED HERE ===
// ===================================================================================

// --- CHAMPION CONFIGURATION ---
const THINKING_TIME_MS = 1500; // 1.5 seconds for high-performance competitive play.
const DENIAL_BONUS = 15;
const LOSING_RISK_APPETITE = 2.0;
const SCORE_THRESHOLD = 15;
const WINNING_RISK_APPETITE = 0.6; // Keep the safe-play value for when ahead.

// --- CORE CONSTANTS ---
const ENDGAME_SOLVER_THRESHOLD = 4; // Re-enabled for maximum endgame strength.
const UCT_EXPLORATION_CONSTANT = 1.41;
const handRanks = { HIGH_CARD: 0, ONE_PAIR: 2, TWO_PAIR: 5, THREE_OF_A_KIND: 10, STRAIGHT: 15, FLUSH: 20, FULL_HOUSE: 25, FOUR_OF_A_KIND: 50, STRAIGHT_FLUSH: 100 };
const rankValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const positionalWeights = [ [1.0, 1.1, 1.2, 1.1, 1.0], [1.1, 1.3, 1.4, 1.3, 1.1], [1.2, 1.4, 1.5, 1.4, 1.2], [1.1, 1.3, 1.4, 1.3, 1.1], [1.0, 1.1, 1.2, 1.1, 1.0] ];


// --- MODULE 1: CORE HELPERS ---
function evaluateHand(hand) { const validCards = hand.filter(c => c); if (validCards.length < 5) return 0; const ranks = validCards.map(c => c[0]); const suits = validCards.map(c => c[1]); const rankCounts = ranks.reduce((acc, rank) => ({ ...acc, [rank]: (acc[rank] || 0) + 1 }), {}); const counts = Object.values(rankCounts).sort((a, b) => b - a); const isFlush = new Set(suits).size === 1; const sortedRanks = ranks.map(r => rankValues[r]).sort((a, b) => a - b); const uniqueRanks = [...new Set(sortedRanks)]; const isStraight = uniqueRanks.length === 5 && (uniqueRanks[4] - uniqueRanks[0] === 4); const isAceLowStraight = JSON.stringify(sortedRanks) === JSON.stringify([2, 3, 4, 5, 14]); if ((isStraight || isAceLowStraight) && isFlush) return handRanks.STRAIGHT_FLUSH; if (counts[0] === 4) return handRanks.FOUR_OF_A_KIND; if (counts[0] === 3 && counts[1] === 2) return handRanks.FULL_HOUSE; if (isFlush) return handRanks.FLUSH; if (isStraight || isAceLowStraight) return handRanks.STRAIGHT; if (counts[0] === 3) return handRanks.THREE_OF_A_KIND; if (counts[0] === 2 && counts[1] === 2) return handRanks.TWO_PAIR; if (counts[0] === 2) return handRanks.ONE_PAIR; return handRanks.HIGH_CARD; }
function scoreGrid(grid) { let totalScore = 0; for (let r = 0; r < 5; r++) { totalScore += evaluateHand(grid[r]); } for (let c = 0; c < 5; c++) { totalScore += evaluateHand([grid[0][c], grid[1][c], grid[2][c], grid[3][c], grid[4][c]]); } return totalScore; }
function applyMove(gameState, move, player) { const newGameState = JSON.parse(JSON.stringify(gameState)); const gridToUpdate = player === 'bot' ? newGameState.myGrid : newGameState.oppGrid; gridToUpdate[move.row][move.col] = move.card; newGameState.community = newGameState.community.filter(c => c !== move.card); return newGameState; }
function getCombinations(arr, size) {const result = []; function combo(startIndex, currentCombo) {if (currentCombo.length === size) { result.push([...currentCombo]); return; } for (let i = startIndex; i < arr.length; i++) {currentCombo.push(arr[i]); combo(i + 1, currentCombo); currentCombo.pop();}}combo(0, []); return result;}
function getPermutations(arr) {const result = []; function permute(currentArr, remainingArr) {if (remainingArr.length === 0) { result.push(currentArr); return; } for (let i = 0; i < remainingArr.length; i++) {const nextRemaining = [...remainingArr]; const next = nextRemaining.splice(i, 1); permute([...currentArr, ...next], nextRemaining);}}permute([], arr); return result;}
function getLiveDeck(myGrid, oppGrid, community) {const allRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']; const allSuits = ['h', 'd', 'c', 's']; const fullDeck = new Set(); for (const suit of allSuits) for (const rank of allRanks) fullDeck.add(rank + suit); const knownCards = [...myGrid.flat(), ...oppGrid.flat(), ...community].filter(c => c); for (const card of knownCards) fullDeck.delete(card); return Array.from(fullDeck);}

// --- STRATEGIC ASSESSMENT ---
function assessGameState(myGrid, oppGrid, community) {
    const directives = { highRiskAppetite: 1.0, denialTargets: new Set() };
    const scoreDiff = scoreGrid(myGrid) - scoreGrid(oppGrid);
    if (scoreDiff < -SCORE_THRESHOLD) { directives.highRiskAppetite = LOSING_RISK_APPETITE; }
    else if (scoreDiff > SCORE_THRESHOLD) { directives.highRiskAppetite = WINNING_RISK_APPETITE; }
    for (let i = 0; i < 5; i++) {
        const oppRow = oppGrid[i].filter(c => c);
        const oppCol = oppGrid.map(r => r[i]).filter(c => c);
        for (const line of [oppRow, oppCol]) {
            if (line.length !== 4) continue;
            const suits = line.map(c => c[1]);
            if (new Set(suits).size === 1) {
                const flushSuit = suits[0];
                community.forEach(card => { if (card && card[1] === flushSuit) directives.denialTargets.add(card); });
            }
        }
    }
    return directives;
}

// --- HEURISTIC ENGINE ---
function getHeuristicScore(grid, move, directives) {
    const tempGrid = grid.map(r => [...r]);
    tempGrid[move.row][move.col] = move.card;
    const immediateGain = scoreGrid(tempGrid) - scoreGrid(grid);
    const positionalBonus = positionalWeights[move.row][move.col];
    let potentialBonus = 0;
    if (directives.denialTargets.has(move.card)) { potentialBonus += DENIAL_BONUS; }
    const row = tempGrid[move.row];
    const col = tempGrid.map(r => r[move.col]);
    for (const line of [row, col]) {
        const suits = line.filter(c => c).map(c => c[1]);
        const suitCounts = suits.reduce((acc, suit) => ({...acc, [suit]: (acc[suit] || 0) + 1}), {});
        const maxSuit = Math.max(0, ...Object.values(suitCounts));
        if (maxSuit === 3) potentialBonus += 1.5;
        if (maxSuit === 4) potentialBonus += 3.0 * directives.highRiskAppetite;
    }
    return (immediateGain * positionalBonus) + potentialBonus;
}

// --- MCTS NODE ---
class MCTSNode {
    constructor(gameState, parent, move, directives) {
        this.gameState = gameState; this.parent = parent; this.move = move; this.children = []; this.totalScoreDifferential = 0; this.visits = 0; this.untriedMoves = this.getLegalMoves();
        this.heuristicScores = new Map(this.untriedMoves.map(m => [JSON.stringify(m), getHeuristicScore(this.gameState.myGrid, m, directives)]));
    }
    get uctScore() {if (this.visits === 0) return Infinity; const exploitation = this.totalScoreDifferential / this.visits; const exploration = UCT_EXPLORATION_CONSTANT * Math.sqrt(Math.log(this.parent.visits) / this.visits); const heuristicBonus = (this.heuristicScores.get(JSON.stringify(this.move)) || 0) / (1 + this.visits); return exploitation + exploration + heuristicBonus;}
    getLegalMoves() {const { myGrid, community } = this.gameState; const emptyCells = []; for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!myGrid[r][c]) emptyCells.push({ r, c }); if (emptyCells.length === 0) return []; const moves = []; for (const card of community) { for (const cell of emptyCells) { moves.push({ card, row: cell.r, col: cell.c }); } } return moves;}
    selectBestChild() {let bestChild = null; let bestScore = -Infinity; for (const child of this.children) {if (child.uctScore > bestScore) { bestScore = child.uctScore; bestChild = child; }} return bestChild;}
    expand(directives) {const move = this.untriedMoves.pop(); const nextGameState = applyMove(this.gameState, move, 'bot'); const childNode = new MCTSNode(nextGameState, this, move, directives); this.children.push(childNode); return childNode;}
}

// --- ENDGAME & SIMULATION LOGIC ---
function solveEndgame(myGrid, oppGrid, community) { console.log("CHAMPION BOT: Engaging Perfect Endgame Solver..."); let bestMove = null; let bestFinalScore = -Infinity; const emptyCells = []; for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!myGrid[r][c]) emptyCells.push({ r, c }); if (emptyCells.length === 0 || community.length < emptyCells.length) return null; const cardCombinations = getCombinations(community, emptyCells.length); for (const cards of cardCombinations) { const placementPermutations = getPermutations(emptyCells); for (const placements of placementPermutations) { const tempGrid = myGrid.map(r => [...r]); for (let i = 0; i < cards.length; i++) { tempGrid[placements[i].r][placements[i].c] = cards[i]; } const finalScore = scoreGrid(tempGrid); if (finalScore > bestFinalScore) { bestFinalScore = finalScore; bestMove = { card: cards[0], row: placements[0].r, col: placements[0].c }; } } } return bestMove; }
function findBestImmediateMove(grid, community) { if (!community || community.length === 0) return null; const emptyCells = []; for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!grid[r][c]) emptyCells.push({ r, c }); if (emptyCells.length === 0) return null; let bestMove = null; let bestScore = -Infinity; for (const card of community) { for (const cell of emptyCells) { const tempGrid = grid.map(r => [...r]); tempGrid[cell.r][cell.c] = card; const currentScore = scoreGrid(tempGrid); if (currentScore > bestScore) { bestScore = currentScore; bestMove = { card: card, row: cell.r, col: cell.c }; } } } return bestMove; }
function simulateSmartGreedyGame(gameState) { let currentGameState = JSON.parse(JSON.stringify(gameState)); let deck = getLiveDeck(currentGameState.myGrid, currentGameState.oppGrid, currentGameState.community).sort(() => 0.5 - Math.random()); let turn = 0; while (currentGameState.myGrid.flat().includes(null) || currentGameState.oppGrid.flat().includes(null)) { const isBotTurn = (turn % 2 === 0 && currentGameState.playerToMove === 'bot') || (turn % 2 !== 0 && currentGameState.playerToMove !== 'bot'); const grid = isBotTurn ? currentGameState.myGrid : currentGameState.oppGrid; const player = isBotTurn ? 'bot' : 'opp'; const move = findBestImmediateMove(grid, currentGameState.community); if (!move) break; currentGameState = applyMove(currentGameState, move, player); if (deck.length > 0) { currentGameState.community.push(deck.pop()); } turn++; } const myFinalScore = scoreGrid(currentGameState.myGrid); const oppFinalScore = scoreGrid(currentGameState.oppGrid); return myFinalScore - oppFinalScore; }

// --- MAIN BOT FUNCTION (was exported, now used locally) ---
function findBestMoveMCTS(myGrid, oppGrid, community) {
    const emptyCells = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!myGrid[r][c]) emptyCells.push({r, c});
    if (emptyCells.length <= ENDGAME_SOLVER_THRESHOLD && emptyCells.length > 0) { return solveEndgame(myGrid, oppGrid, community); }
    if (emptyCells.length === 0) return null;
    const directives = assessGameState(myGrid, oppGrid, community);
    const rootState = { myGrid, oppGrid, community, playerToMove: 'bot' };
    const root = new MCTSNode(rootState, null, null, directives);
    const endTime = Date.now() + THINKING_TIME_MS;
    while (Date.now() < endTime) {
        let node = root;
        while (node.untriedMoves.length === 0 && node.children.length > 0) { node = node.selectBestChild(); }
        if (node.untriedMoves.length > 0) { node = node.expand(directives); }
        const result = simulateSmartGreedyGame(node.gameState);
        while (node !== null) {
            node.visits++;
            node.totalScoreDifferential += result;
            node = node.parent;
        }
    }
    let bestMove = null; let mostVisits = -1;
    for (const child of root.children) {
        if (child.visits > mostVisits) {
            mostVisits = child.visits;
            bestMove = child.move;
        }
    }
    if (!bestMove) {
        const legalMoves = root.getLegalMoves();
        return legalMoves.length > 0 ? legalMoves[0] : null;
     }
    return bestMove;
}

// ===================================================================================
// === ORIGINAL bot.js FILE STARTS HERE (with modifications to bot actions) ===
// ===================================================================================

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
  return str.slice(0, LOG_MAX_CHARS) + ` …[+${str.length - LOG_MAX_CHARS} chars]`;
}
function mask(str, keepStart = 6, keepEnd = 2) {
  if (!str) return str;
  const s = String(str);
  if (s.length <= keepStart + keepEnd) return '*'.repeat(Math.max(4, s.length));
  return s.slice(0, keepStart) + '…' + '*'.repeat(8) + '…' + s.slice(-keepEnd);
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
    '🔌  HTTP REQUEST:',
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
    '🔌  HTTP RESPONSE:',
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
`================= 🤖 STATE ${reason ? `(${reason})` : ''} =================
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
  console.log("🤖 Initial community:", state.community);
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
  console.log(`🤖 GAME OVER (${reason})`);
  logGameState('game_over');
}

/* =======================
   TURN MGMT
   ======================= */
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
  ws.send(JSON.stringify(payload));
}

function computeRequiredForStart(owner) {
  const placedAtStart = (owner === 'me') ? state.myPlaced : state.oppPlaced;
  const remaining = 25 - placedAtStart;
  return Math.min(2, Math.max(0, remaining));
}

async function onOpponentPlacedOne(card, row, col) {
  if (state.gameOver) return;
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
    state.oppPlacedAtTurnStart = state.oppPlaced - state.oppBufferedPlacements;
    if (state.oppBufferedPlacements > 0) {
      state.turnPlacements = state.oppBufferedPlacements;
      state.oppBufferedPlacements = 0;
    }
  }
  state.myTurn = (owner === 'me');
  console.log(state.myTurn ? "🤖 Our turn" : "🤖 Opponent's turn");
  logGameState('beginTurn');
  if (isGameOver()) { finishGame('all cards placed at turn start'); return; }
  if (state.requiredThisTurn === 0) {
    setTimeout(() => { if (!state.gameOver) void endTurnAndRefillSafe(); }, 0);
    return;
  }
  if (state.turnPlacements >= state.requiredThisTurn && owner === 'opp') {
    setTimeout(() => { if (!state.gameOver) void endTurnAndRefillSafe(); }, 0);
  }
}

async function endTurnAndRefillSafe() {
  if (state.gameOver || state.isRefilling) return;
  state.isRefilling = true;
  const toDraw = state.turnPlacements;
  if (toDraw > 0) {
    const drawn = drawFromDeck(toDraw);
    state.community.push(...drawn);
    console.log(`🤖 Drew ${drawn.length} replacement(s):`, drawn, "-> community:", state.community);
  }
  const nextOwner = (state.turnOwner === 'me') ? 'opp' : 'me';
  beginTurn(nextOwner);
  state.isRefilling = false;
  if (!state.gameOver && state.myTurn && state.requiredThisTurn > 0) {
    await sleep(300 + randomInt(400));
    await playMyTurn();
  }
}

// ===================================================================================
// === MODIFIED BOT ACTION ===
// ===================================================================================
function botPlaceOne() {
  if (!state.ws || state.gameOver) return false;
  console.log("🤖 Champion Bot is thinking...");

  // Use the MCTS function to find the best move
  const bestMove = findBestMoveMCTS(state.myGrid, state.oppGrid, state.community);

  if (!bestMove) {
      console.warn("🤖 MCTS couldn't find a move. This shouldn't happen if there are options.");
      return false; // Could not make a move
  }

  const { card, row, col } = bestMove;

  // Update our internal state and send the move to the server
  state.myGrid[row][col] = card;
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

  console.log(`🤖 Our turn: need to place ${need} card(s).`);
  let placed = 0;
  for (let i = 0; i < need; i++) {
    const ok = botPlaceOne();
    if (!ok) break;
    placed += 1;
    if (state.gameOver) break;
    // No extra delay needed as MCTS has its own THINKING_TIME
  }
  if (!state.gameOver && placed < need) {
    console.warn(`🤖 Could not complete required placements (needed ${need}, placed ${placed}).`);
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
    console.error("❌ Failed to confirm ready:", await readyRes.text());
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

  console.log("🤖 Stored match/deck:", {
    matchId: state.matchId,
    deckCount: state.deck.length,
  });

  if (
    state.matchStatus === "in_progress" &&
    !state.gameStarted &&
    state.ws &&
    state.ws.readyState === WebSocket.OPEN
  ) {
    const startPayload = { c2dictionary: true, data: { type: "game_started" } };
    state.ws.send(JSON.stringify(startPayload));
    console.log("🤖 Sent game_started (backend reported in_progress).");
          if (state.gameStarted) return;
      state.gameStarted = true;
      console.log("🤖 GAME STARTED");
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
  console.log(`🤖 Starting Gridora Champion bot for ${email}...`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: loggedFetch } });
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) { console.error("❌ Authentication failed:", authError.message); return; }
  const JWT_TOKEN = authData.session.access_token;
  console.log("🤖 Authenticated.");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/matchmaking`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${JWT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const matchResp = await res.json();
  console.log("🤖 Matchmaking response:", matchResp);
  if (!matchResp.success) { console.error("❌ Matchmaking failed:", matchResp.error); return; }

  const { room, match_id, player1_nickname, player2_nickname } = matchResp.data;
  state.isHost = (match_id === null);
  const matchId = match_id || parseInt(room.split("_").pop());
  const wsJwt = matchResp.token || await createJwtForRoom(room);
  const wsUrl = `wss://${PIESOCKET_INSTANCE_ID}.piesocket.com/v3/${room}?api_key=${PIESOCKET_API_KEY}&jwt=${wsJwt}`;
  console.log('🔌 WS CONNECT:', sanitizeUrl(wsUrl));
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  const rawSend = ws.send;
  ws.send = function (data, ...args) {
    const outStr = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : (() => { try { return JSON.stringify(data); } catch { return String(data); } })();
    console.log('🔌 WS SEND:', ellipsize(outStr));
    return rawSend.call(ws, data, ...args);
  };

  ws.on('open', async () => {
    console.log("🔌 WebSocket connected to room:", room);
    if (state.isHost) {
      console.log("🤖 Host: waiting for opponent...");
    } else {
      const joinPayload = { c2dictionary: true, data: { type: "opponent_joined", match_id: matchId, opponent_nickname: player2_nickname, opponent_rating: "1000", opponent_country: "BRAZIL" } };
      ws.send(JSON.stringify(joinPayload));
      console.log("🤖 Sent opponent_joined payload.");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
    }
  });

  ws.on('message', async (buf) => {
    const text = buf.toString();
    console.log("🔌 WS RECV:", ellipsize(text));
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || !msg.c2dictionary || !msg.data || !msg.data.type) return;
    const type = msg.data.type;

    if (state.isHost && type === "opponent_joined") {
      console.log("🤖 Opponent joined. Confirming ready...");
      await confirmReadyAndStore(JWT_TOKEN, matchId);
      return;
    }
    if (type === "game_started") {
      if (state.gameStarted) return;
      state.gameStarted = true;
      console.log("🤖 GAME STARTED");
      initCommunity();
      beginTurn(state.isHost ? 'me' : 'opp');
      if (state.myTurn && state.requiredThisTurn > 0) {
        await sleep(START_TURN_DELAY_MS);
        await playMyTurn();
      }
      return;
    }
    if (type === "activate_card") { return; }
    if (type === "place_card") {
      const { card, row, col } = msg.data;
      console.log(`🤖 Opponent placed ${card} at r${row},c${col}`);
      await onOpponentPlacedOne(String(card), Number(row), Number(col));
      return;
    }
  });

  ws.on('close', () => console.log("🔌 WebSocket closed."));
  ws.on('error', (err) => console.error("🔌 WebSocket error:", err.message));
}

/* =======================
   ENTRY
   ======================= */
if (process.argv.length < 4) {
  console.log("Usage: node improve_bot.js <email> <password>");
  process.exit(1);
}
const email = process.argv[2];
const password = process.argv[3];
runBot(email, password);