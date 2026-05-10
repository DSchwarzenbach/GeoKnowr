/**
 * lobby.js
 * Handles the lobby screen: hosting/joining a game, configuring settings,
 * and waiting for all players to ready up before the game starts.
 */

import { createGame, getGameByCode, joinGame, getPlayers, setPlayerReady, subscribeToPlayers, subscribeToGame } from "./supabase.js";
import CONFIG from "./config.js";

let LOCATIONS = []; // populated on init via fetch

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let gameState = null;   // full game row from DB
let playerState = null; // this client's player row
let playersChannel = null;
let gameChannel = null;

// ─────────────────────────────────────────────────────────────
// DOM References
// ─────────────────────────────────────────────────────────────
const screens = {
  home:    document.getElementById("screen-home"),
  host:    document.getElementById("screen-host"),
  join:    document.getElementById("screen-join"),
  lobby:   document.getElementById("screen-lobby"),
};

const els = {
  // Home
  btnHost:         document.getElementById("btn-host"),
  btnJoin:         document.getElementById("btn-join"),
  // Host setup
  hostNameInput:   document.getElementById("host-name"),
  roundTimeInput:  document.getElementById("setting-round-time"),
  maxPlayersInput: document.getElementById("setting-max-players"),
  btnCreate:       document.getElementById("btn-create-game"),
  createError:     document.getElementById("create-error"),
  // Join
  joinNameInput:   document.getElementById("join-name"),
  joinCodeInput:   document.getElementById("join-code"),
  btnJoinGame:     document.getElementById("btn-join-game"),
  joinError:       document.getElementById("join-error"),
  // Lobby
  lobbyCode:       document.getElementById("lobby-code"),
  lobbySettings:   document.getElementById("lobby-settings"),
  playerList:      document.getElementById("player-list"),
  btnReady:        document.getElementById("btn-ready"),
  lobbyStatus:     document.getElementById("lobby-status"),
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function pickLocations(count) {
  const shuffled = [...LOCATIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function renderPlayerList(players) {
  els.playerList.innerHTML = players
    .map(
      (p) => `<li class="player-item ${p.is_ready ? "ready" : ""}">
        <span class="player-name">${p.name}</span>
        <span class="player-status">${p.is_ready ? "✓ Ready" : "Waiting..."}</span>
      </li>`
    )
    .join("");
}

function checkAllReady(players) {
  return players.length >= 2 && players.every((p) => p.is_ready);
}

// ─────────────────────────────────────────────────────────────
// Lobby realtime
// ─────────────────────────────────────────────────────────────

async function refreshPlayerList() {
  const players = await getPlayers(gameState.id);
  renderPlayerList(players);

  if (checkAllReady(players)) {
    els.lobbyStatus.textContent = "All players ready — starting game!";
    // Navigate to game after a short delay
    setTimeout(() => {
      sessionStorage.setItem("geoState", JSON.stringify({ game: gameState, player: playerState }));
      window.location.href = "game.html";
    }, 1500);
  }
}

function startLobbySubscriptions() {
  playersChannel = subscribeToPlayers(gameState.id, () => refreshPlayerList());
  gameChannel    = subscribeToGame(gameState.id, ({ new: updatedGame }) => {
    if (updatedGame.status === "playing") {
      sessionStorage.setItem("geoState", JSON.stringify({ game: updatedGame, player: playerState }));
      window.location.href = "game.html";
    }
  });
}

function enterLobby() {
  showScreen("lobby");
  els.lobbyCode.textContent = gameState.room_code;
  const s = gameState.settings;
  els.lobbySettings.textContent =
    `${s.round_count} rounds · ${s.round_time_seconds > 0 ? s.round_time_seconds + "s timer" : "No timer"} · Up to ${s.max_players} players`;
  refreshPlayerList();
  startLobbySubscriptions();
}

// ─────────────────────────────────────────────────────────────
// Host flow
// ─────────────────────────────────────────────────────────────

els.btnHost.addEventListener("click", () => showScreen("host"));

els.btnCreate.addEventListener("click", async () => {
  const hostName = els.hostNameInput.value.trim();
  if (!hostName) return;

  const settings = {
    round_count:          CONFIG.DEFAULTS.ROUND_COUNT,  // fixed: always 5 rounds
    round_time_seconds:   parseInt(els.roundTimeInput.value, 10),
    max_players:          parseInt(els.maxPlayersInput.value, 10),
  };

  const selectedLocations = pickLocations(settings.round_count);
  const roomCode = generateRoomCode();

  els.btnCreate.disabled = true;
  els.btnCreate.textContent = "Creating…";
  if (els.createError) els.createError.textContent = "";

  try {
    gameState   = await createGame({ roomCode, hostName, locations: selectedLocations, settings });
    playerState = await joinGame(gameState.id, hostName);
    enterLobby();
  } catch (e) {
    console.error(e);
    if (els.createError) els.createError.textContent = e.message || "Failed to create game. Check your Supabase config.";
    els.btnCreate.disabled = false;
    els.btnCreate.textContent = "Create Game";
  }
});

// ─────────────────────────────────────────────────────────────
// Join flow
// ─────────────────────────────────────────────────────────────

els.btnJoin.addEventListener("click", () => showScreen("join"));

els.btnJoinGame.addEventListener("click", async () => {
  const name = els.joinNameInput.value.trim();
  const code = els.joinCodeInput.value.trim().toUpperCase();
  els.joinError.textContent = "";

  if (!name || !code) return;

  els.btnJoinGame.disabled = true;
  els.btnJoinGame.textContent = "Joining…";

  try {
    gameState   = await getGameByCode(code);
    if (gameState.status !== "lobby") {
      throw new Error("Game already started.");
    }
    const players = await getPlayers(gameState.id);
    if (players.length >= gameState.settings.max_players) {
      throw new Error("Game is full.");
    }
    playerState = await joinGame(gameState.id, name);
    enterLobby();
  } catch (e) {
    els.joinError.textContent = e.message || "Could not find game. Check the code.";
    els.btnJoinGame.disabled = false;
    els.btnJoinGame.textContent = "Join Game";
  }
});

// ─────────────────────────────────────────────────────────────
// Ready button
// ─────────────────────────────────────────────────────────────

els.btnReady.addEventListener("click", async () => {
  els.btnReady.disabled = true;
  els.btnReady.textContent = "Waiting for others…";
  await setPlayerReady(playerState.id);
});

// ─────────────────────────────────────────────────────────────
// Init — fetch locations then show home screen
// ─────────────────────────────────────────────────────────────
async function init() {
  const res = await fetch("data/locations.json");
  LOCATIONS = await res.json();
  showScreen("home");
}

init();
