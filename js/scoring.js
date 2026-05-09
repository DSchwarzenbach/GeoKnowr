/**
 * scoring.js
 *
 * Replicates GeoGuessr's exact scoring algorithm:
 *   - Max score per round: 5000 points
 *   - Score is an exponential decay based on distance in km
 *   - Formula reverse-engineered from GeoGuessr's own results:
 *       score = 5000 * e^(-distance_km / 2000)
 *   - Score is floored to 0 (never negative)
 *   - Under ~0.15 km → full 5000 points (same as GeoGuessr's exact-hit threshold)
 */

const MAX_SCORE = 5000;
const DECAY_CONSTANT = 2000; // km — controls how steeply score drops off

/**
 * Haversine formula — great-circle distance between two lat/lng points.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in km
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate round score from distance.
 * @param {number} distanceKm
 * @returns {number} integer score 0-5000
 */
export function calculateScore(distanceKm) {
  if (distanceKm < 0.15) return MAX_SCORE; // exact-hit threshold
  const raw = MAX_SCORE * Math.exp(-distanceKm / DECAY_CONSTANT);
  return Math.max(0, Math.round(raw));
}

/**
 * Format a distance for display (km or m).
 * @param {number} distanceKm
 * @returns {string}
 */
export function formatDistance(distanceKm) {
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)} m`;
  }
  return `${distanceKm.toFixed(1)} km`;
}
