/** Severity token names, highest first. Colours live in tokens.css; models override at runtime. */
export const SEVERITY_TOKENS = ['--s5', '--s4', '--s3', '--s2', '--s1'] as const;

/** Layout constants shared by the shell and the stage. */
export const layout = {
  sidebarWidth: 252,
  sidebarCollapsedWidth: 52,
  titleBarHeight: 40,
} as const;

export const TOKENS_CSS_PATH = './tokens.css';
