// Import suffixes served by src/build/inlineImports.ts (renderer build and Vitest).

/** A module bundled with its imports to one minified IIFE, as a string. */
declare module '*?script' {
  const code: string;
  export default code;
}

/** A file's text as it is on disk. */
declare module '*?text' {
  const text: string;
  export default text;
}

/** A file as a `data:` URI. */
declare module '*?datauri' {
  const uri: string;
  export default uri;
}
