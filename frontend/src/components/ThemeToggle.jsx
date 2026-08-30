import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../ThemeContext';

export const ThemeToggle = ({ className = '' }) => {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      id="theme-toggle-btn"
      type="button"
      onClick={toggleTheme}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      className={`relative inline-flex items-center justify-center w-9 h-9 rounded-xl bg-surface2/80 border border-borderstrong/60 hover:border-orange-500/50 text-inksoft hover:text-orange-400 transition-all cursor-pointer shrink-0 ${className}`}
    >
      <Sun
        className={`w-4 h-4 absolute transition-all duration-300 ${
          isLight ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 -rotate-90'
        }`}
      />
      <Moon
        className={`w-4 h-4 absolute transition-all duration-300 ${
          isLight ? 'opacity-0 scale-50 rotate-90' : 'opacity-100 scale-100 rotate-0'
        }`}
      />
    </button>
  );
};
