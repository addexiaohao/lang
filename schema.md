# Schema Design

## Core principles

- The DB stores things the agent **cannot reconstruct** — personal encounters, provenance, skill history, relationships
- The DB does **not** store things the agent already knows — explanations, translations, grammar rules, example sentences, word forms
- A card is a record that something exists in your vocabulary, not a dictionary entry
- The agent regenerates explanations fresh from the card's `name` on demand

---

## Tables

### projects
Top-level organizer. One per language (or learning domain).

```sql
id            uuid PK
name          text        -- "German", "French", "Non-fiction reading"
system_prompt text        -- editable, loaded fresh on every request
settings      jsonb       -- future use
created_at    timestamptz
```

---

### sources
Things you actually encountered in the wild. **Sacred — never drop, additive changes only.**

```sql
id            uuid PK
project_id    uuid FK → projects
original_text text        -- raw foreign text, exactly as encountered
context       text        -- freeform: "Dark S1E3", "p.47", "conversation with Maria"
created_at    timestamptz
```

No `translation` or `explanation` — the agent provides these on demand. `context` is intentionally freeform — type as much or as little as you want.

---

### knowledge_cards
A card says: *this exists in your vocabulary, you've encountered it, you know it this well.*

```sql
id               uuid PK
project_id       uuid FK → projects
kind             text        -- see kinds below
name             text        -- the key the agent uses to reconstruct everything
details          jsonb       -- small structural flags only (see per-kind notes)
tags             text[]
related_card_ids uuid[]
skill_history    jsonb       -- [{ date, score, method }] — future
created_at       timestamptz
```

**No explanation, no translation, no forms, no examples** — the agent knows all of these.

---

### source_knowledge (join table)
Many-to-many between sources and cards. One source can produce many cards; one card can appear in many sources.

```sql
source_id         uuid FK → sources
knowledge_card_id uuid FK → knowledge_cards
excerpt           text    -- surface form as it appeared ("alten", "aufgemacht")
note              text    -- specific to this encounter ("dative plural context", "past participle")
created_at        timestamptz
PRIMARY KEY (source_id, knowledge_card_id)
```

Both foreign keys are indexed — efficient to query in both directions.

---

## Knowledge card kinds

### vocabulary
A single word in dictionary/lemma form.

```json
{
  "kind": "vocabulary",
  "name": "aufmachen",
  "tags": ["verb", "separable"],
  "details": {
    "separable": true,
    "prefix": "auf"
  },
  "related_card_ids": ["uuid-of-separable-verb-splitting-rule"]
}
```

```json
{
  "kind": "vocabulary",
  "name": "fahren",
  "tags": ["verb", "strong"],
  "details": {
    "irregular": true
  }
}
```

`details` stores only structural flags the agent cannot infer from the name alone — `separable`, `prefix`, `irregular`. Nothing encyclopedic.

---

### grammar
A productive pattern you apply to generate new forms or sentences.

```json
{
  "kind": "grammar",
  "name": "Perfekt",
  "tags": ["tense", "past", "spoken"],
  "related_card_ids": [
    "uuid-of-haben-conjugation-table",
    "uuid-of-sein-conjugation-table",
    "uuid-of-past-participle-formation"
  ]
}
```

```json
{
  "kind": "grammar",
  "name": "Verb-final word order — subordinate clauses",
  "tags": ["word-order", "syntax"],
  "related_card_ids": ["uuid-of-v2-rule"]
}
```

`related_card_ids` encodes structural dependencies — things you need to master before this card makes sense.

---

### expression
A fixed chunk learned whole, where meaning does not come from the parts.

Test: *can you figure it out from its components?* If no — it's an expression.

```json
{
  "kind": "expression",
  "name": "Mahlzeit",
  "tags": ["colloquial", "sarcasm"],
  "details": {}
}
```

```json
{
  "kind": "expression",
  "name": "na ja",
  "tags": ["filler", "spoken"],
  "details": {}
}
```

`details` is minimal — just register as a hint to the agent. No definition.

---

### table
A paradigm — a system of forms across multiple axes where skill is tracked **per cell**, not as a single score. The card defines the structure; the agent generates the actual forms on demand.

```json
{
  "kind": "table",
  "name": "German Adjective Declension",
  "description": "Adjective endings vary by case, gender, and article type.",
  "axes": [
    { "name": "case",         "values": ["nominative", "accusative", "dative", "genitive"] },
    { "name": "gender",       "values": ["masculine", "feminine", "neuter", "plural"] },
    { "name": "article_type", "values": ["strong", "mixed", "weak"] }
  ],
  "skill": {
    "accusative.masculine.strong": { "level": "mastered", "last_seen": "2026-05-01" },
    "nominative.masculine.strong": { "level": "familiar", "last_seen": "2026-05-10" },
    "dative.feminine.weak":        { "level": "seen",     "last_seen": "2026-05-15" }
  }
}
```

Cell keys are dot-joined axis values in consistent order (`case.gender.article_type`). Absent cells = never encountered — distinct from seen-but-struggling.

Skill levels: `seen` → `familiar` → `mastered`. Absence = never encountered.

`description` is not an explanation — it's a structural note that tells the agent what the axes mean and how to interpret a cell key.

---

### collocation (future)
Words that bind together idiomatically without being fully fixed expressions.

Examples: *warten auf*, *Entscheidung treffen*, *Angst haben*

Not needed on day one — add when you start hitting this wall naturally.

---

## German card map

| Concept | Kind | Notes |
|---|---|---|
| Adjective declension | table | 3 axes: case × gender × article_type |
| Noun article declension (der/den/dem/des) | table | axes: case × gender |
| Personal pronoun declension | table | axes: case × person |
| Verb conjugation | table | one card per tense |
| What a tense means (Perfekt, Konjunktiv...) | grammar | linked to conjugation table |
| Strong/irregular verbs | vocabulary | `irregular: true` in details |
| Modal verb meanings | vocabulary | one card per modal |
| Modal + infinitive construction | grammar | one card covers all modals |
| Verb-final (subordinate clauses) | grammar | |
| Verb-final (relative clauses) | grammar | |
| V2 rule (main clauses) | grammar | |
| Separable verb splitting rule | grammar | one card covers all separable verbs |
| Individual separable verbs | vocabulary | `separable: true`, `prefix` in details |
| Fixed expressions (Mahlzeit, na ja) | expression | |

---

## What the DB does not store

- Word meanings or translations
- Grammar explanations or construction rules
- Example sentences (unless in `note` on a specific source encounter)
- Conjugated or declined forms (except as cell keys in `skill` on table cards)
- Part of speech, register, collocations

The agent knows all of this. Storing it would be redundant and would go stale as your level changes and the agent's explanations adapt.