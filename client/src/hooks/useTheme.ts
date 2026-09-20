import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = 'outreach-theme'; // same key as the classic UI — preference is shared

export function useTheme() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem(THEME_KEY) || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Keeps the mobile browser chrome the same colour as the canvas. Values
    // mirror --canvas for each theme in styles/theme.css.
    document.getElementById('theme-color')
      ?.setAttribute('content', theme === 'dark' ? '#0a0b0f' : '#f3f4f8');
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
