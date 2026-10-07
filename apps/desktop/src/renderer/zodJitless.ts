// The app CSP (main/csp.ts) allows no JavaScript eval, so zod's fast path, which compiles object
// parsers with `new Function`, can never run in a page. zod would find that out itself and fall
// back, but its probe is a CSP violation in the console; tell it up front. Imported first by every
// renderer entry, before anything parses.
import { config } from 'zod';

config({ jitless: true });
