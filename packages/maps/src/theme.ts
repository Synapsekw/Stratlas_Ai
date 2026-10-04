import { useEffect, useState } from 'react';

/** The resolved app theme (`data-theme` on <html>), updated when it or the language changes. */
export function useDocumentTheme(): 'dark' | 'light' {
  const read = (): 'dark' | 'light' =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(read());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'lang'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);
  return theme;
}
