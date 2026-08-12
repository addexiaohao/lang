const MODE_ITEMS = [
  {
    id: 'learn',
    label: 'Learn',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    id: 'library',
    label: 'Library',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    id: 'practice',
    label: 'Practice',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
]

export function Sidebar({ mode, onModeChange, onOpenSettings, onLogout, header }) {
  return (
    <div className="flex flex-col w-44 shrink-0 bg-white border-r border-gray-200 h-full">
      {/* Project switcher */}
      <div className="px-2 py-2 border-b border-gray-100">
        {header}
      </div>

      {/* Modes */}
      <nav className="flex flex-col gap-0.5 p-2 flex-1">
        {MODE_ITEMS.map(item => {
          const isActive = mode === item.id
          return (
            <button
              key={item.id}
              onClick={() => onModeChange(item.id)}
              title={item.label}
              aria-label={item.label}
              className={`
                flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm transition-colors text-left
                ${isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}
              `}
            >
              <span className={isActive ? 'text-blue-600' : 'text-gray-400'}>
                {item.icon}
              </span>
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* Settings + sign out */}
      <div className="p-2 border-t border-gray-100 flex flex-col gap-0.5">
        <button
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Settings
        </button>
        <button
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out"
          className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </button>
      </div>
    </div>
  )
}
