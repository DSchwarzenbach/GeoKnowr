/**
 * game.js
 * Core gameplay: loads Street View for the current round, manages the
 * guess map, handles the round timer, submits guesses, and waits for all
 * players before showing results.
 */

import CONFIG from "./config.js";
import { haversineDistance, calculateScore } from "./scoring.js";
import {
  submitGuess,
  getGuessesForRound,
  getPlayers,
  updatePlayerScore,
  advanceRound,
  subscribeToGuesses,
  subscribeToGame,
} from "./supabase.js";

// ─────────────────────────────────────────────────────────────
// Restore session state (passed from lobby.js via sessionStorage)
// ─────────────────────────────────────────────────────────────
const { game: gameState, player: playerState } = JSON.parse(sessionStorage.getItem("geoState") || "{}");

if (!gameState || !playerState) {
  // No state found — redirect home
  window.location.href = "index.html";
}

const SETTINGS     = gameState.settings;
const LOCATIONS    = gameState.locations;
const TOTAL_ROUNDS = SETTINGS.round_count;

let currentRound    = gameState.current_round;
let guessMarker     = null;
let guessMap        = null;
let panorama        = null;
let timerInterval   = null;
let hasGuessed      = false;
let myRoundScore    = 0;
let myTotalScore    = playerState.total_score || 0;

// ─────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────
const els = {
  roundLabel:    document.getElementById("round-label"),
  timerDisplay:  document.getElementById("timer-display"),
  totalScore:    document.getElementById("total-score"),
  guessBtn:      document.getElementById("btn-guess"),
  waitingMsg:    document.getElementById("waiting-msg"),
  guessMapEl:    document.getElementById("guess-map"),
  panoEl:        document.getElementById("panorama"),
  resultsPanel:  document.getElementById("results-panel"),
  resultsBody:   document.getElementById("results-body"),
  nextBtn:       document.getElementById("btn-next-round"),
  finalPanel:    document.getElementById("final-panel"),
  finalBody:     document.getElementById("final-body"),
};

// ─────────────────────────────────────────────────────────────
// Initialise Google Maps components
// ─────────────────────────────────────────────────────────────
function initMaps() {
  const location = LOCATIONS[currentRound - 1];

  // Street View panorama
  panorama = new google.maps.StreetViewPanorama(els.panoEl, {
    position: { lat: location.lat, lng: location.lng },
    pov: { heading: 0, pitch: 0 },
    zoom: 1,
    // Disable controls that reveal location
    addressControl: false,
    fullscreenControl: false,
    showRoadLabels: false,
    motionTracking: false,
    motionTrackingControl: false,
  });

  // Guess map (small overlay)
  guessMap = new google.maps.Map(els.guessMapEl, {
    center: { lat: 20, lng: 0 },
    zoom: 1,
    disableDefaultUI: true,
    gestureHandling: "greedy",
    styles: [{ elementType: "labels", stylers: [{ visibility: "off" }] }],
  });

  guessMap.addListener("click", (e) => {
    if (hasGuessed) return;
    placeGuessMarker(e.latLng);
  });
}

function placeGuessMarker(latLng) {
  if (guessMarker) guessMarker.setMap(null);
  guessMarker = new google.maps.Marker({ position: latLng, map: guessMap });
  els.guessBtn.disabled = false;
}

// ─────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────
function startTimer() {
  if (SETTINGS.round_time_seconds <= 0) {
    els.timerDisplay.textContent = "∞";
    return;
  }

  let remaining = SETTINGS.round_time_seconds;
  els.timerDisplay.textContent = remaining;

  timerInterval = setInterval(() => {
    remaining -= 1;
    els.timerDisplay.textContent = remaining;
    if (remaining <= 10) els.timerDisplay.classList.add("timer-urgent");
    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (!hasGuessed) autoSubmit();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  els.timerDisplay.classList.remove("timer-urgent");
}

// ─────────────────────────────────────────────────────────────
// Guess submission
// ─────────────────────────────────────────────────────────────
els.guessBtn.addEventListener("click", submitMyGuess);

async function autoSubmit() {
  // If timer runs out with no guess, submit the center of the map
  const center = guessMap.getCenter();
  placeGuessMarker(center);
  await submitMyGuess();
}

async function submitMyGuess() {
  if (hasGuessed) return;
  hasGuessed = true;
  stopTimer();
  els.guessBtn.disabled = true;
  els.waitingMsg.classList.remove("hidden");

  const actualLocation = LOCATIONS[currentRound - 1];
  const guessPos       = guessMarker.getPosition();
  const distanceKm     = haversineDistance(
    actualLocation.lat, actualLocation.lng,
    guessPos.lat(), guessPos.lng()
  );
  myRoundScore = calculateScore(distanceKm);

  await submitGuess({
    gameId:      gameState.id,
    playerId:    playerState.id,
    roundNumber: currentRound,
    guessedLat:  guessPos.lat(),
    guessedLng:  guessPos.lng(),
    distanceKm,
    roundScore:  myRoundScore,
  });
}

// ─────────────────────────────────────────────────────────────
// Realtime — watch for all players to have guessed
// ─────────────────────────────────────────────────────────────
subscribeToGuesses(gameState.id, async () => {
  const [guesses, players] = await Promise.all([
    getGuessesForRound(gameState.id, currentRound),
    getPlayers(gameState.id),
  ]);

  if (guesses.length >= players.length) {
    // All players have guessed — show results
    showRoundResults(guesses, players);
  }
});

// ─────────────────────────────────────────────────────────────
// Results Panel
// ─────────────────────────────────────────────────────────────
function showRoundResults(guesses, players) {
  els.waitingMsg.classList.add("hidden");
  els.resultsPanel.classList.remove("hidden");

  const actualLocation = LOCATIONS[currentRound - 1];

  // Build a results map showing actual location + all guesses
  const resultsMap = new google.maps.Map(document.getElementById("results-map"), {
    center: { lat: actualLocation.lat, lng: actualLocation.lng },
    zoom: 3,
    disableDefaultUI: true,
  });

  // Actual location marker
  new google.maps.Marker({
    position: actualLocation,
    map: resultsMap,
    icon: { url: "https://maps.google.com/mapfiles/ms/icons/red-dot.png" },
    title: "Actual Location",
  });

  // Player guess markers + lines
  guesses.forEach((g) => {
    const pos = { lat: g.guessed_lat, lng: g.guessed_lng };
    const playerName = g.players?.name || "Player";
    new google.maps.Marker({ position: pos, map: resultsMap, title: playerName });
    new google.maps.Polyline({
      path: [pos, actualLocation],
      map: resultsMap,
      strokeColor: "#888",
      strokeDashArray: [4, 4],
    });
  });

  // Leaderboard rows
  const sortedGuesses = [...guesses].sort((a, b) => b.round_score - a.round_score);
  els.resultsBody.innerHTML = sortedGuesses
    .map(
      (g, i) =>
        `<tr class="${g.player_id === playerState.id ? "highlight" : ""}">
          <td>#${i + 1}</td>
          <td>${g.players?.name || "Player"}</td>
          <td>${g.distance_km < 1 ? Math.round(g.distance_km * 1000) + " m" : g.distance_km.toFixed(1) + " km"}</td>
          <td>${g.round_score.toLocaleString()}</td>
        </tr>`
    )
    .join("");

  // Update my total score display
  myTotalScore += myRoundScore;
  els.totalScore.textContent = myTotalScore.toLocaleString();
  updatePlayerScore(playerState.id, myTotalScore);

  const isLastRound = currentRound >= TOTAL_ROUNDS;
  els.nextBtn.textContent = isLastRound ? "See Final Results" : `Next Round (${currentRound}/${TOTAL_ROUNDS})`;
}

els.nextBtn.addEventListener("click", async () => {
  els.resultsPanel.classList.add("hidden");
  currentRound += 1;

  if (currentRound > TOTAL_ROUNDS) {
    await showFinalResults();
    return;
  }

  // Update game state in DB (host drives this — last to click "next" triggers it)
  // Simple approach: each client advances independently since game state is read-only after init
  resetRound();
});

// ─────────────────────────────────────────────────────────────
// Final Results
// ─────────────────────────────────────────────────────────────
async function showFinalResults() {
  await advanceRound(gameState.id, currentRound, TOTAL_ROUNDS);
  const players = await getPlayers(gameState.id);
  const sorted  = [...players].sort((a, b) => b.total_score - a.total_score);

  document.getElementById("final-panel").classList.remove("hidden");
  document.getElementById("game-area").classList.add("hidden");

  document.getElementById("final-body").innerHTML = sorted
    .map(
      (p, i) =>
        `<tr class="${p.id === playerState.id ? "highlight" : ""}">
          <td>${["🥇", "🥈", "🥉"][i] || `#${i + 1}`}</td>
          <td>${p.name}</td>
          <td>${p.total_score.toLocaleString()}</td>
        </tr>`
    )
    .join("");
}

// ─────────────────────────────────────────────────────────────
// Round lifecycle
// ─────────────────────────────────────────────────────────────
function resetRound() {
  hasGuessed   = false;
  guessMarker  = null;
  myRoundScore = 0;

  els.guessBtn.disabled  = true;
  els.waitingMsg.classList.add("hidden");
  els.timerDisplay.classList.remove("timer-urgent");
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;

  initMaps();
  startTimer();
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
window.initGame = function () {
  // Called by the Google Maps script callback
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;
  els.totalScore.textContent = "0";
  initMaps();
  startTimer();
};
