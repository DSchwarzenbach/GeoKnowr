/**
 * supabase.js
 * Initialises the Supabase client and exports typed helper functions
 * for all game state operations the app needs.
 */

import CONFIG from "./config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

export let supabase = null;
try {
  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
} catch (e) {
  console.warn("Supabase not configured locally — Solo Mode only.");
}
// ─────────────────────────────────────────────────────────────
// GAMES
// ─────────────────────────────────────────────────────────────

/** Create a new game row and return it. */
export async function createGame({ roomCode, hostName, locations, settings }) {
  const { data, error } = await supabase
    .from("games")
    .insert({ room_code: roomCode, host_name: hostName, locations, settings })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Fetch a game by its room code. */
export async function getGameByCode(roomCode) {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("room_code", roomCode.toUpperCase())
    .single();
  if (error) throw error;
  return data;
}

/** Advance the game to the next round (or mark finished). */
export async function advanceRound(gameId, nextRound, totalRounds) {
  const status = nextRound > totalRounds ? "finished" : "playing";
  const { error } = await supabase
    .from("games")
    .update({ current_round: nextRound, status })
    .eq("id", gameId);
  if (error) throw error;
}

/** Subscribe to changes on a specific game row. */
export function subscribeToGame(gameId, callback) {
  return supabase
    .channel(`game:${gameId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` }, callback)
    .subscribe();
}

// ─────────────────────────────────────────────────────────────
// PLAYERS
// ─────────────────────────────────────────────────────────────

/** Add a player to a game and return the player row. */
export async function joinGame(gameId, playerName) {
  const { data, error } = await supabase
    .from("players")
    .insert({ game_id: gameId, name: playerName })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Fetch all players in a game. */
export async function getPlayers(gameId) {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at");
  if (error) throw error;
  return data;
}

/** Mark a player as ready in the lobby. */
export async function setPlayerReady(playerId) {
  const { error } = await supabase
    .from("players")
    .update({ is_ready: true })
    .eq("id", playerId);
  if (error) throw error;
}

/** Update a player's total score. */
export async function updatePlayerScore(playerId, totalScore) {
  const { error } = await supabase
    .from("players")
    .update({ total_score: totalScore })
    .eq("id", playerId);
  if (error) throw error;
}

/** Subscribe to player list changes for a game. */
export function subscribeToPlayers(gameId, callback) {
  return supabase
    .channel(`players:${gameId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `game_id=eq.${gameId}` }, callback)
    .subscribe();
}

// ─────────────────────────────────────────────────────────────
// GUESSES
// ─────────────────────────────────────────────────────────────

/** Submit a player's guess for a round. */
export async function submitGuess({ gameId, playerId, roundNumber, guessedLat, guessedLng, distanceKm, roundScore }) {
  const { data, error } = await supabase
    .from("guesses")
    .insert({
      game_id: gameId,
      player_id: playerId,
      round_number: roundNumber,
      guessed_lat: guessedLat,
      guessed_lng: guessedLng,
      distance_km: distanceKm,
      round_score: roundScore,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Fetch all guesses for a specific round. */
export async function getGuessesForRound(gameId, roundNumber) {
  const { data, error } = await supabase
    .from("guesses")
    .select("*, players(name)")
    .eq("game_id", gameId)
    .eq("round_number", roundNumber);
  if (error) throw error;
  return data;
}

/** Subscribe to new guesses for a game (any round). */
export function subscribeToGuesses(gameId, callback) {
  return supabase
    .channel(`guesses:${gameId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "guesses", filter: `game_id=eq.${gameId}` }, callback)
    .subscribe();
}
