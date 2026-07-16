import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = 'outreach-theme'; // same key as the classic UI — preference is shared

export function useTheme() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem(THEME_KEY) || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
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
