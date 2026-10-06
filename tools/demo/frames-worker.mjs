// Worker thread of the demo builder: builds the world once, then renders the frames the main
// thread asks for (drone video), posting raw RGB back.
import { parentPort, workerData } from 'node:worker_threads';
import { createWorld } from './world.mjs';

const { seed, epoch, ss } = workerData;
const world = createWorld(seed, epoch);
parentPort.postMessage({ ready: true });
parentPort.on('message', (msg) => {
  if (msg.stop) {
    process.exit(0);
  }
  const { rgb } = world.renderer.render(msg.cam, { ss });
  parentPort.postMessage({ index: msg.index, rgb }, [rgb.buffer]);
});
