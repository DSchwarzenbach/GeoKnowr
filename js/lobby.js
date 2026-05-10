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
  solo:    document.getElementById("screen-solo"),
  host:    document.getElementById("screen-host"),
  join:    document.getElementById("screen-join"),
  lobby:   document.getElementById("screen-lobby"),
};

const els = {
  // Home
  btnSolo:         document.getElementById("btn-solo"),
  btnHost:         document.getElementById("btn-host"),
  btnJoin:         document.getElementById("btn-join"),
  // Solo setup
  soloNameInput:   document.getElementById("solo-name"),
  soloRoundTime:   document.getElementById("solo-round-time"),
  soloRounds:      document.getElementById("solo-rounds"),
  btnStartSolo:    document.getElementById("btn-start-solo"),
  soloError:       document.getElementById("solo-error"),
  btnBackSolo:     document.getElementById("btn-back-solo"),
  // Host setup
  hostNameInput:   document.getElementById("host-name"),
  roundTimeInput:  document.getElementById("setting-round-time"),
  maxPlayersInput: document.getElementById("setting-max-players"),
  btnCreate:       document.getElementById("btn-create-game"),
  createError:     document.getElementById("create-error"),
  btnBackHost:     document.getElementById("btn-back-host"),
  // Join
  joinNameInput:   document.getElementById("join-name"),
  joinCodeInput:   document.getElementById("join-code"),
  btnJoinGame:     document.getElementById("btn-join-game"),
  joinError:       document.getElementById("join-error"),
  btnBackJoin:     document.getElementById("btn-back-join"),
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

/**
 * Load the Google Maps JS API (needed for StreetViewService in the lobby).
 * Resolves immediately if already loaded.
 */
function loadMapsApi() {
  return new Promise((resolve) => {
    if (window.google && window.google.maps) { resolve(); return; }
    window.__lobbyMapsReady = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&callback=__lobbyMapsReady`;
    script.async = true;
    document.head.appendChild(script);
  });
}

/**
 * Pick `count` locations that are confirmed to have Street View coverage
 * within 5km. Keeps drawing from the shuffled pool until enough valid
 * ones are found. Progress callback receives (found, needed).
 */
async function pickValidLocations(count, onProgress) {
  await loadMapsApi();
  const sv = new google.maps.StreetViewService();
  const shuffled = [...LOCATIONS].sort(() => Math.random() - 0.5);
  const valid = [];

  for (const loc of shuffled) {
    if (valid.length >= count) break;

    try {
      const snapped = await new Promise((resolve, reject) => {
        sv.getPanorama(
          {
            location: loc,
            radius: 5000,
            source: google.maps.StreetViewSource.OUTDOOR,
            preference: google.maps.StreetViewPreference.NEAREST,
          },
          (data, status) => {
            if (status === google.maps.StreetViewStatus.OK) {
              resolve({
                lat: data.location.latLng.lat(),
                lng: data.location.latLng.lng(),
              });
            } else {
              reject();
            }
          }
        );
      });
      valid.push(snapped);
      onProgress(valid.length, count);
    } catch {
      // No coverage at this coord — skip and try next
    }
  }

  if (valid.length < count) {
    throw new Error(`Could only find ${valid.length}/${count} locations with Street View coverage. Try again.`);
  }
  return valid;
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

els.btnSolo.addEventListener("click", () => showScreen("solo"));
els.btnHost.addEventListener("click", () => showScreen("host"));
els.btnJoin.addEventListener("click", () => showScreen("join"));
els.btnBackSolo.addEventListener("click", () => showScreen("home"));
els.btnBackHost.addEventListener("click", () => showScreen("home"));
els.btnBackJoin.addEventListener("click", () => showScreen("home"));

// ─────────────────────────────────────────────────────────────
// Solo flow — no Supabase, pure client-side
// ─────────────────────────────────────────────────────────────
els.btnStartSolo.addEventListener("click", async () => {
  const name = els.soloNameInput.value.trim();
  if (!name) {
    els.soloError.textContent = "Please enter your name.";
    return;
  }

  const roundCount = parseInt(els.soloRounds.value, 10);
  const roundTime  = parseInt(els.soloRoundTime.value, 10);

  els.btnStartSolo.disabled = true;
  els.soloError.textContent = "";

  try {
    els.btnStartSolo.textContent = `Finding locations (0/${roundCount})…`;
    const locations = await pickValidLocations(roundCount, (found, total) => {
      els.btnStartSolo.textContent = `Finding locations (${found}/${total})…`;
    });

    const gameId   = "solo-" + Date.now();
    const playerId = "solo-player-" + Date.now();

    const soloState = {
      isSolo: true,
      game: {
        id:            gameId,
        room_code:     "SOLO",
        host_name:     name,
        status:        "playing",
        locations,
        settings: {
          round_count:        roundCount,
          round_time_seconds: roundTime,
          max_players:        1,
        },
        current_round: 1,
      },
      player: {
        id:          playerId,
        game_id:     gameId,
        name,
        is_ready:    true,
        total_score: 0,
      },
    };

    sessionStorage.setItem("geoState", JSON.stringify(soloState));
    window.location.href = "game.html";
  } catch (e) {
    console.error(e);
    els.soloError.textContent = e.message || "Failed to find locations. Try again.";
    els.btnStartSolo.disabled = false;
    els.btnStartSolo.textContent = "Start Game";
  }
});

els.btnCreate.addEventListener("click", async () => {
  const hostName = els.hostNameInput.value.trim();
  if (!hostName) {
    if (els.createError) els.createError.textContent = "Please enter your name.";
    return;
  }

  const settings = {
    round_count:        CONFIG.DEFAULTS.ROUND_COUNT,
    round_time_seconds: parseInt(els.roundTimeInput.value, 10),
    max_players:        parseInt(els.maxPlayersInput.value, 10),
  };

  els.btnCreate.disabled = true;
  if (els.createError) els.createError.textContent = "";

  const roomCode = generateRoomCode();

  try {
    // Validate each location against Street View before creating the game.
    // Button shows live progress: "Finding locations (2/5)…"
    els.btnCreate.textContent = "Finding locations (0/5)\u2026";
    const verifiedLocations = await pickValidLocations(
      settings.round_count,
      (found, total) => {
        els.btnCreate.textContent = `Finding locations (${found}/${total})\u2026`;
      }
    );

    els.btnCreate.textContent = "Creating\u2026";
    gameState   = await createGame({ roomCode, hostName, locations: verifiedLocations, settings });
    playerState = await joinGame(gameState.id, hostName);
    enterLobby();
  } catch (e) {
    console.error(e);
    if (els.createError) els.createError.textContent = e.message || "Failed to create game. Check your config.";
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

  if (!name || !code) {
    els.joinError.textContent = "Please enter both name and code.";
    return;
  }

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
