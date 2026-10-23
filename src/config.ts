export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
export const MAX_POSTER_BYTES = 512 * 1024;
export const SESSION_SECONDS = 12 * 60 * 60;

export const TIERS = {
  day: { name: "1 day", days: 1, limit: 5 },
  week: { name: "7 days", days: 7, limit: 3 },
  month: { name: "30 days", days: 30, limit: 2 },
} as const;

export type TierId = keyof typeof TIERS;

export const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
]);