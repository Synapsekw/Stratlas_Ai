declare module '*.css';

// The bundled Natural Earth shapes are read as text and parsed once (a typed JSON import would
// have TypeScript infer the type of 750 kB of coordinates).
declare module 'world-atlas/countries-50m.json?raw' {
  const text: string;
  export default text;
}
