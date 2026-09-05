import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { apiFetch } from './apiFetch.js'
import { LanguagePack } from '../lib/languagePack.js'

// The active project's language pack, fetched once from GET /api/language-pack and rebuilt into
// the same isomorphic LanguagePack class the server uses — so SkillBadge / SkillsPanel /
// CardDetailPanel derive skill-type order + applicability from the DB config, not a hardcoded
// table. The pack editor calls refreshLanguagePack() after a save so those views update.

const Ctx = createContext({ pack: null, refreshLanguagePack: () => {} })

const EMPTY_PACK = new LanguagePack({ skillTypes: [], drillRules: [], meta: {} })

export function LanguagePackProvider({ projectId, children }) {
  const [pack, setPack] = useState(null)

  const refreshLanguagePack = useCallback(async () => {
    if (!projectId) { setPack(null); return }
    try {
      const r = await apiFetch(`/api/language-pack?project_id=${projectId}`)
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
      setPack(new LanguagePack({ skillTypes: data.skill_types, drillRules: data.drill_rules, meta: data.meta }))
    } catch (e) {
      console.error('[language-pack] load failed:', e.message)
      setPack(EMPTY_PACK) // degraded (no bars) but the app keeps working
    }
  }, [projectId])

  useEffect(() => { refreshLanguagePack() }, [refreshLanguagePack])

  return <Ctx.Provider value={{ pack, refreshLanguagePack }}>{children}</Ctx.Provider>
}

export function useLanguagePack() {
  return useContext(Ctx).pack
}

export function useRefreshLanguagePack() {
  return useContext(Ctx).refreshLanguagePack
}
