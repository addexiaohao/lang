import { useState } from 'react'

// Popover checkbox-list — same shape as SaveCard.jsx's tag picker (fixed-backdrop-to-close +
// absolute panel). Shared by CardsPanel (tags filter, plan.md §7) and SkillsPanel (tags + practice
// state filters, plan.md §2).
export function MultiSelectPopover({ label, options, selected, onToggle }) {
  const [open, setOpen] = useState(false)
  const activeCount = selected.size
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`text-[10px] rounded px-1.5 py-0.5 transition-colors ${activeCount > 0 ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
      >
        {label}{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} aria-label="Close" />
          <div className="absolute left-0 top-full mt-1 z-20 w-48 max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
            {options.length === 0 && <p className="text-[10px] text-gray-400 text-center py-2">None</p>}
            {options.map(opt => (
              <label key={opt.value} className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.has(opt.value)} onChange={() => onToggle(opt.value)} className="w-3 h-3" />
                <span className="text-[10px] text-gray-700 flex-1 truncate">{opt.label}</span>
                {opt.count != null && <span className="text-[9px] text-gray-400">{opt.count}</span>}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
