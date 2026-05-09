/**
 * config.js
 * Loads API keys from a local `.env` file (or inline here for local dev).
 *
 * HOW TO USE:
 *   1. Copy `.env.example` to `.env`
 *   2. Fill in your keys.
 *   3. For a pure static site (no build tool), paste your values directly
 *      into the PLACEHOLDERS below — the .gitignore prevents accidental commits.
 *
 * For production, use a build tool (Vite, etc.) to inject env vars at build time.
 */

const CONFIG = {
  // ----------------------------------------------------------------
  // Google Maps JavaScript API key
  // Enable: Maps JavaScript API, Street View Static API
  // ----------------------------------------------------------------
  GOOGLE_MAPS_API_KEY: "YOUR_GOOGLE_MAPS_API_KEY",

  // ----------------------------------------------------------------
  // Supabase
  // ----------------------------------------------------------------
  SUPABASE_URL: "YOUR_SUPABASE_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",

  // ----------------------------------------------------------------
  // Default Game Settings (can be overridden in lobby)
  // ----------------------------------------------------------------
  DEFAULTS: {
    ROUND_COUNT: 5,
    ROUND_TIME_SECONDS: 60, // set to 0 for no timer
    MAX_PLAYERS: 3,
  },
};

export default CONFIG;
