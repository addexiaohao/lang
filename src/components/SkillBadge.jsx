import { SKILL_TYPES, deriveFlatSkillTypes } from '../../lib/skillTypes.js'
import { levelToColor } from '../levelColor.js'

// Level 1-10 -> bar height in px, linear.
const MIN_HEIGHT = 6
const MAX_HEIGHT = 20
function levelToHeight(level) {
  return MIN_HEIGHT + (level - 1) / 9 * (MAX_HEIGHT - MIN_HEIGHT)
}

// One bar per skill type the card can have, fixed in registry order (never sorted by level) so a
// bar's position is always readable positionally. A skill with no row, or level = null, renders as
// level 1 — a display decision only, not a claim that the skill has been assessed.
// `card` needs { kind, tags, details }; `skills` is that card's skill rows ({ type, level }[]).
// Paradigm cards (details.axes present) render nothing — see plan.md's "Paradigm cards" section.
export function SkillBadge({ card, skills }) {
  if (card.details?.axes) return null

  const order = SKILL_TYPES[card.kind] ?? []
  const applicable = new Set(deriveFlatSkillTypes(card))
  const types = order.filter(t => applicable.has(t))
  if (types.length === 0) return null

  const levelByType = new Map((skills ?? []).map(s => [s.type, s.level]))
  const label = types.map(type => `${type} ${levelByType.get(type) ?? 1}`).join(', ')

  return (
    <div className="flex items-end gap-[3px] h-[22px] shrink-0" role="img" aria-label={label}>
      {types.map(type => {
        const level = levelByType.get(type) ?? 1
        return (
          <div
            key={type}
            aria-hidden="true"
            title={`${type} · ${level}`}
            className="w-[6px] rounded-sm"
            style={{ height: `${levelToHeight(level)}px`, backgroundColor: levelToColor(level) }}
          />
        )
      })}
    </div>
  )
}
