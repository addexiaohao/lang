// Shared red -> amber -> green ramp for a 1-10 skill level, interpolated linearly in RGB between
// named stops (tailwind's red-500/amber-500/green-500) — used by SkillBadge (Cards panel) and
// SkillsPanel (Skills page) so a level always reads as the same colour everywhere in the app.
const RAMP_STOPS = [
  { level: 1, rgb: [239, 68, 68] },
  { level: 5.5, rgb: [245, 158, 11] },
  { level: 10, rgb: [34, 197, 94] },
]

export function levelToColor(level) {
  const clamped = Math.max(1, Math.min(10, level))
  let lo = RAMP_STOPS[0], hi = RAMP_STOPS[RAMP_STOPS.length - 1]
  for (let i = 0; i < RAMP_STOPS.length - 1; i++) {
    if (clamped >= RAMP_STOPS[i].level && clamped <= RAMP_STOPS[i + 1].level) {
      lo = RAMP_STOPS[i]; hi = RAMP_STOPS[i + 1]
      break
    }
  }
  const span = hi.level - lo.level
  const t = span === 0 ? 0 : (clamped - lo.level) / span
  const [r, g, b] = lo.rgb.map((c, i) => Math.round(c + (hi.rgb[i] - c) * t))
  return `rgb(${r}, ${g}, ${b})`
}

// Single-hue 1-10 ramp (tailwind amber-100 -> amber-700) for a card's `importance` — deliberately
// a different hue family from levelToColor's red->green so an importance badge and a level badge
// are never visually confusable at a glance (importance is "how much it matters", level is "how
// well you know it" — two different axes shown next to each other on a Skills page row).
const IMPORTANCE_RGB_LOW = [254, 243, 199]  // amber-100
const IMPORTANCE_RGB_HIGH = [180, 83, 9]    // amber-700

export function importanceToColor(importance) {
  const clamped = Math.max(1, Math.min(10, importance))
  const t = (clamped - 1) / 9
  const [r, g, b] = IMPORTANCE_RGB_LOW.map((c, i) => Math.round(c + (IMPORTANCE_RGB_HIGH[i] - c) * t))
  return `rgb(${r}, ${g}, ${b})`
}
