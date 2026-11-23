import type { AudioEngine } from "./audio";

type StepHandler = (step: number, when: number) => void;

export function createClock(audio: AudioEngine) {
  const subscribers: StepHandler[] = [];
  let bpm = 105;
  let playing = false;
  let anchorStep = 0;
  let anchorTime = 0;
  let nextStep = 0;
  let pausedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stepDur = () => 60 / bpm / 4;

  const pos = () =>
    playing && audio.isReady() ? anchorStep + Math.max(0, (audio.now() - anchorTime) / stepDur()) : pausedAt;

  function tick() {
    if (!playing || !audio.isReady()) return;
    const horizon = audio.now() + 0.12;
    while (anchorTime + (nextStep - anchorStep) * stepDur() < horizon) {
      const when = anchorTime + (nextStep - anchorStep) * stepDur();
      for (const handler of subscribers) handler(nextStep, when);
      nextStep++;
    }
  }

  return {
    get playing() {
      return playing;
    },
    get bpm() {
      return bpm;
    },
    stepDur,
    pos,

    setBpm(nextBpm: number) {
      const current = pos();
      bpm = nextBpm;
      if (playing) {
        anchorStep = current;
        anchorTime = audio.now();
      }
    },

    onStep(handler: StepHandler) {
      subscribers.push(handler);
    },

    start() {
      audio.ensure();
      if (playing) return;
      playing = true;
      anchorStep = pausedAt;
      anchorTime = audio.now() + 0.05;
      nextStep = Math.ceil(anchorStep);
      timer = setInterval(tick, 25);
      tick();
    },

    stop() {
      if (!playing) return;
      pausedAt = pos();
      playing = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },

    toggle() {
      if (playing) this.stop();
      else this.start();
    },

    seek(step: number) {
      if (!playing) pausedAt = step;
    },
  };
}

export type Clock = ReturnType<typeof createClock>;
