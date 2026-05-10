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
let resultsShown    = false;  // guard against duplicate realtime events
let myRoundScore    = 0;
let myTotalScore    = playerState.total_score || 0;

// ─────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────
const els = {
  roundLabel:    document.getElementById("round-label"),
  roundDots:     document.getElementById("round-dots"),
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
  compassNeedle: document.getElementById("compass-needle"),
  compassHeading: document.getElementById("compass-heading"),
};

// ─────────────────────────────────────────────────────────────
// Round progress dots
// ─────────────────────────────────────────────────────────────
function initRoundDots() {
  els.roundDots.innerHTML = Array.from({ length: TOTAL_ROUNDS }, (_, i) =>
    `<div class="round-dot ${i + 1 < currentRound ? "done" : i + 1 === currentRound ? "current" : ""}"></div>`
  ).join("");
}

function updateRoundDots() {
  const dots = els.roundDots.querySelectorAll(".round-dot");
  dots.forEach((dot, i) => {
    dot.className = "round-dot";
    if (i + 1 < currentRound)  dot.classList.add("done");
    if (i + 1 === currentRound) dot.classList.add("current");
  });
}

// ─────────────────────────────────────────────────────────────
// Compass
// ─────────────────────────────────────────────────────────────
function syncCompass(heading) {
  const h = ((heading % 360) + 360) % 360;
  els.compassNeedle.style.setProperty("--heading", `${h}deg`);
  els.compassHeading.textContent = `${Math.round(h)}\u00b0`;
}

// ─────────────────────────────────────────────────────────────
// Initialise Google Maps components
// ─────────────────────────────────────────────────────────────
function initMaps() {
  const location = LOCATIONS[currentRound - 1];

  // Guess map (small overlay) — init immediately
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

  // Force tile repaint — delayed so browser has finished layout
  setTimeout(() => google.maps.event.trigger(guessMap, "resize"), 250);

  // Find nearest Street View coverage before loading panorama
  const sv = new google.maps.StreetViewService();
  sv.getPanorama(
    { location: { lat: location.lat, lng: location.lng }, radius: 50000, preference: google.maps.StreetViewPreference.NEAREST },
    (data, status) => {
      if (status === google.maps.StreetViewStatus.OK) {
        // Snap the stored location to the actual panorama position so scoring is accurate
        LOCATIONS[currentRound - 1] = {
          lat: data.location.latLng.lat(),
          lng: data.location.latLng.lng(),
        };
        panorama = new google.maps.StreetViewPanorama(els.panoEl, {
          pano: data.location.pano,
          pov: { heading: Math.random() * 360, pitch: 0 },
          zoom: 1,
          addressControl: false,
          fullscreenControl: false,
          showRoadLabels: false,
          motionTracking: false,
          motionTrackingControl: false,
        });
        // Sync compass whenever the player pans
        panorama.addListener("pov_changed", () => {
          syncCompass(panorama.getPov().heading);
        });
        // Trigger map resize once panorama has loaded (layout may shift)
        panorama.addListener("position_changed", () => {
          setTimeout(() => google.maps.event.trigger(guessMap, "resize"), 100);
        });
        syncCompass(panorama.getPov().heading);
      } else {
        // No coverage within 50km — show a message and skip this location
        els.panoEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;font-size:1.2rem;">No Street View here — auto-submitting...</div>`;
        // Auto-submit from center of map after 2s so game doesn't stall
        setTimeout(() => { if (!hasGuessed) autoSubmit(); }, 2000);
      }
    }
  );
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

  // Update live guess counter while waiting
  if (hasGuessed && !resultsShown) {
    els.waitingMsg.textContent = `\u23f3 ${guesses.length} / ${players.length} players guessed`;
  }

  // Guard: only show results once even if duplicate events fire
  if (guesses.length >= players.length && !resultsShown) {
    resultsShown = true;
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
  resultsShown = false;
  guessMarker  = null;
  myRoundScore = 0;

  els.guessBtn.disabled  = true;
  els.waitingMsg.classList.add("hidden");
  els.timerDisplay.classList.remove("timer-urgent");
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;

  updateRoundDots();
  initMaps();
  startTimer();
}

// ─────────────────────────────────────────────────────────────
// Boot — dynamically load the Maps API so the key comes from
// config.js (single source of truth) and there is no race
// condition between the async script tag and this ES module.
// ─────────────────────────────────────────────────────────────
function loadMapsApi() {
  return new Promise((resolve) => {
    if (window.google && window.google.maps) { resolve(); return; }
    window.__mapsReady = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&callback=__mapsReady`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  });
}

loadMapsApi().then(() => {
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;
  els.totalScore.textContent = "0";
  initRoundDots();
  initMaps();
  startTimer();
});
