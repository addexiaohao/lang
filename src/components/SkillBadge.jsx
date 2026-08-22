import { SKILL_TYPES, deriveFlatSkillTypes, hasSenseAxis, senseValues, axisValueKey, axisValueGloss } from '../../lib/skillTypes.js'
import { levelToColor } from '../levelColor.js'

// Level 1-10 -> bar height in px, linear.
const MIN_HEIGHT = 6
const MAX_HEIGHT = 20
function levelToHeight(level) {
  return MIN_HEIGHT + (level - 1) / 9 * (MAX_HEIGHT - MIN_HEIGHT)
}

function Bars({ entries, label }) {
  return (
    <div className="flex items-end gap-[3px] h-[22px] shrink-0" role="img" aria-label={label}>
      {entries.map(({ key, level, title }) => (
        <div
          key={key}
          aria-hidden="true"
          title={title}
          className="w-[6px] rounded-sm"
          style={{ height: `${levelToHeight(level)}px`, backgroundColor: levelToColor(level) }}
        />
      ))}
    </div>
  )
}

// One bar per skill type the card can have, fixed in registry order (never sorted by level) so a
// bar's position is always readable positionally. A skill with no row, or level = null, renders as
// level 1 — a display decision only, not a claim that the skill has been assessed.
// `card` needs { kind, tags, details }; `skills` is that card's skill rows ({ type, level }[]) —
// already resolved to the external skill_type by the caller's API layer (a sense skill's DB type is
// literally 'meaning', but `skills` here always carries its sense key — see lib/skillTypes.js's
// resolveSkillType()). A sense-split card (plan.md — "Word Senses") gets one bar per sense, in axis
// order; any OTHER paradigm card (a declension grid etc.) still renders nothing — a multi-axis grid
// has no single meaningful bar order the way a one-dimensional sense axis does.
export function SkillBadge({ card, skills }) {
  const levelByType = new Map((skills ?? []).map(s => [s.type, s.level]))

  if (hasSenseAxis(card)) {
    const senses = senseValues(card)
    if (senses.length === 0) return null
    const entries = senses.map(v => {
      const key = axisValueKey(v)
      const gloss = axisValueGloss(v)
      const level = levelByType.get(key) ?? 1
      return { key, level, title: `${key}${gloss ? ` — ${gloss}` : ''} · ${level}` }
    })
    return <Bars entries={entries} label={entries.map(e => `${e.key} ${e.level}`).join(', ')} />
  }

  if (card.details?.axes) return null

  const order = SKILL_TYPES[card.kind] ?? []
  const applicable = new Set(deriveFlatSkillTypes(card))
  const types = order.filter(t => applicable.has(t))
  if (types.length === 0) return null

  const entries = types.map(type => {
    const level = levelByType.get(type) ?? 1
    return { key: type, level, title: `${type} · ${level}` }
  })
  return <Bars entries={entries} label={entries.map(e => `${e.key} ${e.level}`).join(', ')} />
}
