import { brand } from '@aio/brand';
import { SceneView } from '@aio/engine';

/** Phase 0 shell: Mission title bar and an empty stage. Stream S2 builds the real shell. */
export function App() {
  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">{brand.productName.toUpperCase()}</span>
        <span className="chip">Offline</span>
      </header>
      <main className="stage">
        <SceneView className="scene" />
      </main>
    </div>
  );
}
