// Practice-state enum shared by the Skills page's SQL (schema.sql's skill_practice_state) and its
// API/frontend consumers — see plan.md §1. Order here is display priority (worst first), matching
// the badge's job: draw the eye to failures before neutral/positive rows.
export const PRACTICE_STATES = ['failing', 'too_hard', 'never_practiced', 'passing']

export const PRACTICE_STATE_LABELS = {
  never_practiced: 'never practiced',
  failing: 'failing',
  too_hard: 'too hard',
  passing: 'passing',
}
