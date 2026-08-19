// Standalone, repeatable backfill: walks existing knowledge_cards and (1) creates any missing flat
// skill rows (level = null, never practiced) per lib/skillTypes.js's deriveFlatSkillTypes(), and (2) fills in
// `importance` on existing flat skill rows that don't have one yet — both via
// deriveSkillImportance(kind, type, card.importance). Rows that already carry a manually-set
// importance are left untouched. Paradigm cards (details.axes present) are skipped — their cells
// appear lazily, not via backfill.
// Idempotent: upserts on (card_id, type) with ignoreDuplicates, safe to re-run on a
// partially-migrated DB.
//
// Usage: node scripts/backfill-skills.js [--dry-run]

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { deriveFlatSkillTypes, deriveSkillImportance } from '../lib/skillTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const dryRun = process.argv.includes('--dry-run')

const { VITE_SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
if (!VITE_SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
  process.exit(1)
}

const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SECRET_KEY)

const PAGE_SIZE = 500

async function main() {
  let offset = 0
  let cardsVisited = 0
  let skillsCreated = 0
  let skillsSkippedExisting = 0
  let importanceBackfilled = 0
  const perKindCreated = {}

  while (true) {
    const { data: cards, error } = await supabase
      .from('knowledge_cards')
      .select('id, kind, tags, details, importance')
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      console.error('Failed to fetch knowledge_cards:', error.message)
      process.exit(1)
    }
    if (!cards.length) break

    const flatCards = cards.filter(c => {
      const axes = c.details?.axes
      return !(Array.isArray(axes) && axes.length > 0) // paradigm cards get no eager cells
    })

    const cardIds = flatCards.map(c => c.id)
    const { data: existingSkills, error: existingErr } = cardIds.length
      ? await supabase.from('skill').select('id, card_id, type, importance').in('card_id', cardIds)
      : { data: [], error: null }
    if (existingErr) {
      console.error('Failed to fetch existing skills:', existingErr.message)
      process.exit(1)
    }
    const existingByCard = new Map()
    for (const row of existingSkills) {
      if (!existingByCard.has(row.card_id)) existingByCard.set(row.card_id, new Map())
      existingByCard.get(row.card_id).set(row.type, row)
    }

    const toInsert = []
    const toUpdateImportance = []
    for (const card of cards) {
      cardsVisited++
      const axes = card.details?.axes
      if (Array.isArray(axes) && axes.length > 0) continue

      const types = deriveFlatSkillTypes(card)
      const existing = existingByCard.get(card.id) ?? new Map()
      const missing = types.filter(t => !existing.has(t))
      skillsSkippedExisting += types.length - missing.length
      if (missing.length > 0) {
        perKindCreated[card.kind] = (perKindCreated[card.kind] ?? 0) + missing.length
        skillsCreated += missing.length
        for (const type of missing) {
          toInsert.push({
            card_id: card.id,
            type,
            level: null,
            importance: deriveSkillImportance(card.kind, type, card.importance),
          })
        }
      }

      for (const type of types) {
        const row = existing.get(type)
        if (!row || row.importance != null) continue
        importanceBackfilled++
        toUpdateImportance.push({
          id: row.id,
          importance: deriveSkillImportance(card.kind, type, card.importance),
        })
      }
    }

    if (!dryRun && toInsert.length > 0) {
      const { error: upsertErr } = await supabase
        .from('skill')
        .upsert(toInsert, { onConflict: 'card_id,type', ignoreDuplicates: true })
      if (upsertErr) {
        console.error('Failed to insert skill rows:', upsertErr.message)
        process.exit(1)
      }
    }

    if (!dryRun) {
      for (const { id, importance } of toUpdateImportance) {
        const { error: updateErr } = await supabase.from('skill').update({ importance }).eq('id', id)
        if (updateErr) {
          console.error('Failed to update skill importance:', updateErr.message)
          process.exit(1)
        }
      }
    }

    offset += PAGE_SIZE
  }

  console.log(dryRun ? '[dry run] No writes performed.' : 'Backfill complete.')
  console.log(`Cards visited: ${cardsVisited}`)
  console.log(`Skills created: ${skillsCreated}`)
  console.log(`Skills skipped (already existed): ${skillsSkippedExisting}`)
  console.log(`Skill rows with importance backfilled: ${importanceBackfilled}`)
  console.log('Per-kind created:', perKindCreated)
}

main()
