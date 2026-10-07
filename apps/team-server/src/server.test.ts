import { routeSuite } from './routeSuite';
import { createMemoryStore } from './store/memory';

routeSuite('memory', () => Promise.resolve(createMemoryStore()));
