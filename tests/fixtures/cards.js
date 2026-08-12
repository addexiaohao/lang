// Fixed, realistic card fixtures for the practice test suite — stand in for what api/practice.js
// would otherwise read from Supabase (a knowledge_cards row and a sample of other project cards
// for vocabulary seeding). GERMAN_*'s tags match the real project's
// tag catalog and card-naming convention (see fixtures/projects.js's GERMAN_PROJECT system_prompt
// — a "production" card is named "<lemma> + <use-case>", not the bare lemma). SWEDISH_* are still
// plausible placeholders, not real data.

export const GERMAN_GRAMMAR_CARD = {
  card: {
    id: 'fixture-grammar-de',
    name: 'nach + place name',
    kind: 'grammar',
    tags: ['production', 'production-which-preposition', 'production-which-preposition-destination'],
    details: {},
  },
  seedCardNames: ['Fenster', 'aufmachen', 'Buch', 'Tisch', 'gehen', 'Weihnachtsferien'],
}

export const GERMAN_VOCAB_CARD = {
  card: { id: 'fixture-vocab-de', name: 'aufmachen', kind: 'vocabulary', tags: ['verb', 'verb-separable'], details: {} },
  seedCardNames: ['Fenster', 'Buch', 'Tisch', 'gehen', 'nach'],
}

export const SWEDISH_GRAMMAR_CARD = {
  card: { id: 'fixture-grammar-sv', name: 'till', kind: 'grammar', tags: ['preposition'], details: {} },
  seedCardNames: ['ordlista', 'skriva', 'brev', 'kompis'],
}

export const SWEDISH_VOCAB_CARD = {
  card: { id: 'fixture-vocab-sv', name: 'skriva', kind: 'vocabulary', tags: ['verb', 'irregular-past', 'irregular-supine'], details: {} },
  seedCardNames: ['ordlista', 'brev', 'kompis', 'till'],
}
