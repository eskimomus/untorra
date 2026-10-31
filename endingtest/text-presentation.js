import { SceneClock } from './story.js?v=13';

export function syncAnimations(animations, paused) {
  for (const animation of animations) {
    if (paused && animation.playState === 'running') animation.pause();
    else if (!paused && animation.playState === 'paused') animation.play();
  }
}

export function syncSceneAnimations(animations, { suspended, transitioning, waitingForGesture }) {
  for (const animation of animations) {
    const paused = suspended || waitingForGesture || (transitioning && animation.id !== 'echo-jitter');
    syncAnimations([animation], paused);
  }
}

export function echoRevealGroups(mainPositions, echoPositions) {
  const ordered = echoPositions.map((position, index) => ({ index, distance: Math.min(...mainPositions.map(main => Math.abs(position - main))) }))
    .sort((first, second) => first.distance - second.distance);
  const groups = [];
  for (const echo of ordered) {
    const previous = groups.at(-1);
    if (!previous || echo.distance - previous.distance > 6) groups.push({ distance: echo.distance, indices: [echo.index] });
    else previous.indices.push(echo.index);
  }
  return groups.map(group => group.indices);
}

export function echoJitterFrames(random = Math.random, scale = 1) {
  return Array.from({ length: 20 }, () => ({ transform: `translate(${Math.round((random() - 0.5) * 2) / scale}px, ${Math.round((random() - 0.5) * 2) / scale}px)`, easing: 'steps(1, end)' }));
}

export function typingTokens(text, { atomicWords = [], voice = 'player', random = Math.random } = {}) {
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const atomic = atomicWords.find(word => text.slice(offset, offset + word.length).toUpperCase() === word.toUpperCase()
      && !/[\p{L}\p{N}]/u.test(text[offset - 1] || '')
      && !/[\p{L}\p{N}]/u.test(text[offset + word.length] || ''));
    const character = atomic || String.fromCodePoint(text.codePointAt(offset));
    const start = offset;
    offset += character.length;
    let duration = 30 + random() * 75;
    if (random() < 0.15) duration += 70 + random() * 140;
    if (/\s/u.test(character)) duration += 35;
    if (/[,.?!:;]/u.test(character)) duration += 120 + random() * 170;
    if (atomic) duration = 420;
    tokens.push({ start, end: offset, sound: atomic ? 'untorra' : /\S/u.test(character) ? voice : null, duration });
  }
  return tokens;
}

export class Sequence {
  constructor(options) {
    this.clock = new SceneClock(() => this.advance(), options);
    this.active = false;
    this.generation = 0;
  }

  play(steps, onComplete = () => {}) {
    this.cancel();
    this.steps = steps;
    this.cursor = 0;
    this.onComplete = onComplete;
    this.active = true;
    this.advance();
  }

  advance() {
    if (!this.active) return;
    const step = this.steps[this.cursor++];
    if (!step) {
      this.active = false;
      this.onComplete();
      return;
    }
    const generation = this.generation;
    step.run?.();
    if (this.active && generation === this.generation) this.clock.enter(step.duration);
  }

  cancel() {
    this.generation += 1;
    this.active = false;
    this.steps = [];
    this.clock.enter(null);
  }

  pause(reason) { this.clock.pause(reason); }
  resume(reason) { this.clock.resume(reason); }
}

export class TypingAudio {
  constructor() {
    this.enabled = true;
    this.suspended = false;
    this.voices = new Set();
    this.bytes = Promise.all([
      ['god', 'type-god.wav'], ['player', 'type-player.wav'], ['untorra', 'untorra.wav'],
    ].map(async ([name, file]) => {
      const response = await fetch(`assets/audio/${file}`);
      if (!response.ok) throw new Error(`Audio unavailable: ${file}`);
      return [name, await response.arrayBuffer()];
    })).catch(() => []);
  }

  unlock(context) {
    if (!context) return Promise.resolve();
    if (!this.loading) {
      this.context = context;
      this.gain = context.createGain();
      this.gain.gain.value = 0.7;
      this.gain.connect(context.destination);
      this.loading = this.bytes.then(entries => Promise.all(entries.map(async ([name, bytes]) => [name, await context.decodeAudioData(bytes)])))
        .then(entries => { this.buffers = new Map(entries); })
        .catch(() => {});
    }
    return this.loading;
  }

  duration(name) { return this.buffers?.get(name)?.duration ?? 0; }

  play(name, { onEnded } = {}) {
    if (!this.enabled || this.suspended || this.context?.state !== 'running') return;
    const buffer = this.buffers?.get(name);
    if (!buffer) return;
    while (this.voices.size >= 4) this.stopVoice(this.voices.values().next().value);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.gain);
    const voice = { source, gain, duration: buffer.duration };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      source.disconnect();
      gain.disconnect();
      onEnded?.();
    };
    source.start();
    return voice;
  }

  stopVoice(voice) {
    this.voices.delete(voice);
    const now = this.context.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, 0.003);
    voice.source.stop(now + 0.015);
  }

  stop() {
    for (const voice of this.voices) this.stopVoice(voice);
  }

  setSuspended(suspended, enabled) {
    this.suspended = suspended;
    this.enabled = enabled;
    if (suspended || !enabled) this.stop();
  }
}
