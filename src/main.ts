import "./style.css";

import { createAudio } from "./audio";
import { createClock } from "./clock";
import { createEngine, type Lock } from "./engine";
import { wireInput } from "./input";
import { createLayout } from "./layout";
import { createPerformance } from "./performance";
import { createRenderer } from "./render";
import { createHarmony } from "./theory";

const dom = {
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
  playBtn: document.getElementById("play") as HTMLButtonElement,
  bpmInput: document.getElementById("bpm") as HTMLInputElement,
  volumeEl: document.getElementById("volume") as HTMLDivElement,
  guideDialog: document.getElementById("guide") as HTMLDialogElement,
};

const audio = createAudio();
const clock = createClock(audio);
const harmony = createHarmony();
const layout = createLayout<Lock>(dom.canvas);
const engine = createEngine(audio, clock, harmony);

let syncPlayButton = (_playing: boolean) => {};
const fx = createPerformance(audio, clock, harmony, layout, engine, (playing) => syncPlayButton(playing));
const renderer = createRenderer(layout, harmony, engine, fx);

({ syncPlayButton } = wireInput(dom, audio, clock, layout, engine, fx, renderer));

const frame = () => {
  engine.state.pos = clock.pos();
  renderer.draw();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
