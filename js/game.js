/**
 * game.js
 * Core gameplay: Street View, guess map, timer, scoring, realtime sync.
 *
 * Key design decisions:
 *  - guessMap is created ONCE and reused across rounds (recreating it corrupts state)
 *  - Realtime is best-effort; a polling fallback fires every 2s after guessing
 *  - resultsShown flag prevents double-rendering from duplicate events
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
} from "./supabase.js";

// ─────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────
const { game: gameState, player: playerState, isSolo } = JSON.parse(
  sessionStorage.getItem("geoState") || "{}"
);

if (!gameState || !playerState) {
  window.location.href = "index.html";
}

const SETTINGS     = gameState.settings;
const LOCATIONS    = gameState.locations;   // array of {lat,lng}, mutable (snapped each round)
const TOTAL_ROUNDS = SETTINGS.round_count;

// ─────────────────────────────────────────────────────────────
// Round state — reset between rounds
// ─────────────────────────────────────────────────────────────
let currentRound   = gameState.current_round;
let hasGuessed     = false;
let resultsShown   = false;
let myRoundScore   = 0;
let myTotalScore   = playerState.total_score || 0;
let guessMarker    = null;
let timerInterval  = null;
let pollInterval   = null;
let soloGuesses    = [];   // stores guess data locally in solo mode

// ─────────────────────────────────────────────────────────────
// Maps state — created ONCE, never recreated
// ─────────────────────────────────────────────────────────────
let guessMap  = null;
let panorama  = null;

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────
const els = {
  roundLabel:     document.getElementById("round-label"),
  roundDots:      document.getElementById("round-dots"),
  timerDisplay:   document.getElementById("timer-display"),
  totalScore:     document.getElementById("total-score"),
  guessBtn:       document.getElementById("btn-guess"),
  waitingMsg:     document.getElementById("waiting-msg"),
  guessMapEl:     document.getElementById("guess-map"),
  panoEl:         document.getElementById("panorama"),
  resultsPanel:   document.getElementById("results-panel"),
  resultsBody:    document.getElementById("results-body"),
  nextBtn:        document.getElementById("btn-next-round"),
  finalPanel:     document.getElementById("final-panel"),
  finalBody:      document.getElementById("final-body"),
  compassNeedle:  document.getElementById("compass-needle"),
  compassHeading: document.getElementById("compass-heading"),
  gameArea:       document.getElementById("game-area"),
  btnExpandMap:   document.getElementById("btn-expand-map"),
  guessMapContainer: document.getElementById("guess-map-container"),
};

// ─────────────────────────────────────────────────────────────
// Round progress dots
// ─────────────────────────────────────────────────────────────
function initRoundDots() {
  els.roundDots.innerHTML = Array.from({ length: TOTAL_ROUNDS }, (_, i) =>
    `<div class="round-dot ${i + 1 === currentRound ? "current" : ""}"></div>`
  ).join("");
}

function updateRoundDots() {
  els.roundDots.querySelectorAll(".round-dot").forEach((dot, i) => {
    dot.className = "round-dot";
    if (i + 1 < currentRound)   dot.classList.add("done");
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
// Guess map — created ONCE at boot, reused every round
// ─────────────────────────────────────────────────────────────
function initGuessMap() {
  const mapEl = els.guessMapEl;

  guessMap = new google.maps.Map(mapEl, {
    center: { lat: 20, lng: 0 },
    zoom: 1,
    disableDefaultUI: true,
    gestureHandling: "greedy",
  });

  guessMap.addListener("click", (e) => {
    if (hasGuessed) return;
    placeGuessMarker(e.latLng);
  });

  // Expand map logic — resize but preserve current center so pin doesn't jump
  els.btnExpandMap.addEventListener("click", () => {
    els.guessMapContainer.classList.toggle("expanded");
    setTimeout(() => safeResizeMap(), 300);
  });

  // Staggered resize triggers: covers layout-shift timing edge-cases
  requestAnimationFrame(() => safeResizeMap());
  setTimeout(() => safeResizeMap(), 400);
  setTimeout(() => safeResizeMap(), 1000);
}

/**
 * safeResizeMap — trigger a map resize while preserving whatever center/zoom
 * the user last set. This prevents resize events from jumping the map to a
 * different position (e.g. after panorama load or expand/collapse transitions).
 */
function safeResizeMap() {
  const center = guessMap.getCenter();
  const zoom   = guessMap.getZoom();
  google.maps.event.trigger(guessMap, "resize");
  if (center) guessMap.setCenter(center);
  if (zoom !== undefined) guessMap.setZoom(zoom);
}

function resetGuessMap() {
  // Clear marker, re-centre — do NOT recreate the Map instance
  if (guessMarker) {
    guessMarker.setMap(null);
    guessMarker = null;
  }
  // Reset to world view, then resize so tiles render at the correct position
  guessMap.setCenter({ lat: 20, lng: 0 });
  guessMap.setZoom(1);
  google.maps.event.trigger(guessMap, "resize");
  // Re-apply after resize so the map doesn't drift to a stale tile origin
  guessMap.setCenter({ lat: 20, lng: 0 });
}

// ─────────────────────────────────────────────────────────────
// Street View — created fresh each round (panoramas are distinct)
// ─────────────────────────────────────────────────────────────
function loadPanorama() {
  const location = LOCATIONS[currentRound - 1];
  const sv = new google.maps.StreetViewService();

  sv.getPanorama(
    {
      location: { lat: location.lat, lng: location.lng },
      radius: 50000,
      source: google.maps.StreetViewSource.OUTDOOR,
      preference: google.maps.StreetViewPreference.NEAREST,
    },
    (data, status) => {
      if (status === google.maps.StreetViewStatus.OK) {
        // Snap stored coord to actual panorama position for accurate scoring
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

        panorama.addListener("pov_changed", () =>
          syncCompass(panorama.getPov().heading)
        );

        // Re-trigger guess map resize after panorama settles (layout shifts).
        // Use safeResizeMap so an already-placed marker pin doesn't appear to move.
        panorama.addListener("status_changed", () => {
          requestAnimationFrame(() => safeResizeMap());
        });

        syncCompass(panorama.getPov().heading);
      } else {
        // No coverage — show message and auto-submit after 2s
        els.panoEl.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;
                      height:100%;color:#64748b;font-size:1.1rem;flex-direction:column;gap:1rem;">
            <span style="font-size:2rem;">🌐</span>
            No Street View coverage here — skipping round…
          </div>`;
        setTimeout(() => { if (!hasGuessed) autoSubmit(); }, 2000);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────
// Guess marker
// ─────────────────────────────────────────────────────────────
function placeGuessMarker(latLng) {
  if (guessMarker) guessMarker.setMap(null);
  guessMarker = new google.maps.Marker({ position: latLng, map: guessMap });
  els.guessBtn.disabled = false;
  // Pan smoothly to the placed marker so the user can see their pin
  guessMap.panTo(latLng);
}

// ─────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────
function startTimer() {
  if (SETTINGS.round_time_seconds <= 0) {
    els.timerDisplay.textContent = "\u221e";
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
  placeGuessMarker(guessMap.getCenter());
  await submitMyGuess();
}

async function submitMyGuess() {
  if (hasGuessed) return;
  hasGuessed = true;
  stopTimer();
  els.guessBtn.disabled = true;
  els.waitingMsg.classList.remove("hidden");
  els.waitingMsg.textContent = isSolo ? "\u23f3 Calculating score\u2026" : "\u23f3 Submitting\u2026";

  const actual   = LOCATIONS[currentRound - 1];
  const guessPos = guessMarker.getPosition();
  const distanceKm = haversineDistance(
    actual.lat, actual.lng,
    guessPos.lat(), guessPos.lng()
  );
  myRoundScore = calculateScore(distanceKm);

  if (isSolo) {
    // Solo: store result in memory, show results immediately
    soloGuesses = [{
      player_id:   playerState.id,
      players:     { name: playerState.name },
      guessed_lat: guessPos.lat(),
      guessed_lng: guessPos.lng(),
      distance_km: distanceKm,
      round_score: myRoundScore,
    }];
    resultsShown = true;
    setTimeout(() => showRoundResults(soloGuesses, [playerState]), 300);
    return;
  }

  // Multiplayer: submit to Supabase
  try {
    await submitGuess({
      gameId:      gameState.id,
      playerId:    playerState.id,
      roundNumber: currentRound,
      guessedLat:  guessPos.lat(),
      guessedLng:  guessPos.lng(),
      distanceKm,
      roundScore:  myRoundScore,
    });
    els.waitingMsg.textContent = "\u23f3 1 / ? players guessed";
  } catch (e) {
    console.error("Guess submit failed:", e);
    els.waitingMsg.textContent = "Failed to submit \u2014 retrying\u2026";
    setTimeout(async () => {
      try { await submitGuess({ gameId: gameState.id, playerId: playerState.id, roundNumber: currentRound, guessedLat: guessPos.lat(), guessedLng: guessPos.lng(), distanceKm, roundScore: myRoundScore }); }
      catch {}
    }, 1000);
  }

  startResultsPoll();
}

// ─────────────────────────────────────────────────────────────
// Results gate — called by realtime AND polling fallback
// ─────────────────────────────────────────────────────────────
async function checkAndShowResults() {
  if (resultsShown) return;

  const [guesses, players] = await Promise.all([
    getGuessesForRound(gameState.id, currentRound),
    getPlayers(gameState.id),
  ]);

  // Update live counter
  if (hasGuessed && !resultsShown) {
    els.waitingMsg.textContent = `\u23f3 ${guesses.length} / ${players.length} players guessed`;
  }

  if (guesses.length >= players.length && !resultsShown) {
    resultsShown = true;
    stopResultsPoll();
    showRoundResults(guesses, players);
  }
}

function startResultsPoll() {
  stopResultsPoll();
  pollInterval = setInterval(checkAndShowResults, 2000);
}

function stopResultsPoll() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// Realtime + polling (multiplayer only — solo shows results immediately)
if (!isSolo) {
  subscribeToGuesses(gameState.id, checkAndShowResults);
}

// ─────────────────────────────────────────────────────────────
// Round results panel
// ─────────────────────────────────────────────────────────────
function showRoundResults(guesses, players) {
  stopResultsPoll();
  els.waitingMsg.classList.add("hidden");
  els.resultsPanel.classList.remove("hidden");

  const actual = LOCATIONS[currentRound - 1];

  // Results map
  const resultsMap = new google.maps.Map(document.getElementById("results-map"), {
    center: { lat: actual.lat, lng: actual.lng },
    zoom: 3,
    disableDefaultUI: true,
  });

  // Actual location pin (red)
  new google.maps.Marker({
    position: actual,
    map: resultsMap,
    icon: { url: "https://maps.google.com/mapfiles/ms/icons/red-dot.png" },
    title: "Actual Location",
  });

  // Player pins + lines
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(actual);

  guesses.forEach((g) => {
    const pos = { lat: g.guessed_lat, lng: g.guessed_lng };
    bounds.extend(pos);
    new google.maps.Marker({
      position: pos,
      map: resultsMap,
      title: g.players?.name || "Player",
    });
    new google.maps.Polyline({
      path: [pos, actual],
      map: resultsMap,
      strokeColor: "#4ade80",
      strokeOpacity: 0.6,
      strokeWeight: 2,
    });
  });

  resultsMap.fitBounds(bounds, { padding: 60 });

  // Leaderboard
  const sortedGuesses = [...guesses].sort((a, b) => b.round_score - a.round_score);
  els.resultsBody.innerHTML = sortedGuesses.map((g, i) =>
    `<tr class="${g.player_id === playerState.id ? "highlight" : ""}">
      <td>#${i + 1}</td>
      <td>${g.players?.name || "Player"}</td>
      <td>${g.distance_km < 1
        ? Math.round(g.distance_km * 1000) + " m"
        : g.distance_km.toFixed(1) + " km"}</td>
      <td>${g.round_score.toLocaleString()}</td>
    </tr>`
  ).join("");

  // Score
  myTotalScore += myRoundScore;
  els.totalScore.textContent = myTotalScore.toLocaleString();
  updatePlayerScore(playerState.id, myTotalScore);

  const isLast = currentRound >= TOTAL_ROUNDS;
  els.nextBtn.textContent = isLast ? "See Final Results" : `Next Round (${currentRound}/${TOTAL_ROUNDS})`;
}

els.nextBtn.addEventListener("click", async () => {
  els.resultsPanel.classList.add("hidden");
  currentRound += 1;

  if (currentRound > TOTAL_ROUNDS) {
    showFinalResults();
    return;
  }

  resetRound();
});

// ─────────────────────────────────────────────────────────────
// Final results
// ─────────────────────────────────────────────────────────────
async function showFinalResults() {
  if (!isSolo) {
    try { await advanceRound(gameState.id, currentRound, TOTAL_ROUNDS); } catch {}
  }

  // Build player list: in solo mode, use local state
  const players = isSolo
    ? [{ ...playerState, total_score: myTotalScore }]
    : await getPlayers(gameState.id);

  const sorted = [...players].sort((a, b) => b.total_score - a.total_score);

  els.finalPanel.classList.remove("hidden");
  els.gameArea.classList.add("hidden");

  els.finalBody.innerHTML = sorted.map((p, i) =>
    `<tr class="${p.id === playerState.id ? "highlight" : ""}">
      <td>${["\ud83e\udd47", "\ud83e\udd48", "\ud83e\udd49"][i] || `#${i + 1}`}</td>
      <td>${p.name}</td>
      <td>${p.total_score.toLocaleString()}</td>
    </tr>`
  ).join("");
}

// ─────────────────────────────────────────────────────────────
// Round lifecycle
// ─────────────────────────────────────────────────────────────
function resetRound() {
  hasGuessed   = false;
  resultsShown = false;
  myRoundScore = 0;
  soloGuesses  = [];

  stopTimer();
  stopResultsPoll();

  els.guessBtn.disabled = true;
  els.waitingMsg.classList.add("hidden");
  els.timerDisplay.classList.remove("timer-urgent");
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;

  updateRoundDots();
  resetGuessMap();    // reuse existing map instance
  loadPanorama();     // fresh panorama for this round
  startTimer();
}

// ─────────────────────────────────────────────────────────────
// Boot — load Maps API dynamically then start round 1
// ─────────────────────────────────────────────────────────────
function loadMapsApi() {
  return new Promise((resolve) => {
    if (window.google && window.google.maps) { resolve(); return; }
    window.__mapsReady = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&callback=__mapsReady`;
    script.async = true;
    document.head.appendChild(script);
  });
}

loadMapsApi().then(() => {
  els.roundLabel.textContent = `Round ${currentRound} / ${TOTAL_ROUNDS}`;
  els.totalScore.textContent = "0";
  initRoundDots();
  initGuessMap();   // create guess map once
  loadPanorama();   // load first panorama
  startTimer();
});
