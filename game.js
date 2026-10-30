function assetPath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}
function img(rel) { return assetPath('renders/' + rel); }
// SOUND_VERSIONS cache-busts individual audio files whenever one gets
// hand-replaced with new content after already shipping — browsers keep
// serving old cached bytes for the same URL otherwise (same issue hit with
// the collider PNGs, see lift_2_1__red's ?v=2 fix). Bump the number here
// (not the filename/COLLIDER_DATA references) whenever a file is swapped.
const SOUND_VERSIONS = { 'door hit.ogg': 2 };
function sound(rel) {
  const v = SOUND_VERSIONS[rel];
  return assetPath('assets/audio/' + rel) + (v ? '?v=' + v : '');
}
function musicSound(rel) { return assetPath('assets/music/' + rel); }

// -10dB applied to every one-shot SFX (door sounds, beeps, elevator cues,
// rhythm notes, etc.) — separate from AMBIENT_MASTER_VOL, which only
// covers the looping ambience beds.
const ONESHOT_VOL = Math.pow(10, -10 / 20);
// The 4 ezh beacon rhythm notes (note 1-4.ogg, not lift_panel's "terminal
// note" files) are +10dB on top of that — net back to unity gain, same
// "exempt this one from the general one-shot attenuation" shape as finalNoise.
const NOTE_BOOST = Math.pow(10, 10 / 20);
// One-shots play through the shared AudioContext off a pre-decoded buffer
// (filled by preloadAllAssets), not a fresh `new Audio()` per call. The old
// element-per-play approach had two real problems: every play paid a
// fetch/decode cost before any sound came out (the preloader's plain
// fetch() didn't help — media elements issue their own range requests and
// don't reliably reuse that cache entry), and each element was subject to
// autoplay policy on its own, so Safari silently rejected every SFX fired
// from a setTimeout chain (rhythm notes, tablo playback) rather than a
// click. A decoded buffer starts sample-immediately and rides the one
// context unlock. Falls back to the old path only while a buffer is still
// decoding, so early clicks aren't silent.
const sfxBuffers = {};
function playOneShot(file, vol, rhythm = false) {
  const boost = /^note [1-4]\.ogg$/.test(file) ? NOTE_BOOST : 1;
  const volume = (vol ?? 1) * ONESHOT_VOL * boost;
  const buffer = sfxBuffers[file];
  if (audioCtx && buffer) {
    tryResumeAudio();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;
    src.connect(gainNode);
    if (rhythm && !rhythmGainNode) {
      rhythmGainNode = audioCtx.createGain();
      rhythmGainNode.gain.value = rhythmVolume;
      rhythmGainNode.connect(masterGainNode);
    }
    gainNode.connect(rhythm ? rhythmGainNode : masterGainNode);
    src.start(0);
    return src;
  }
  const audio = new Audio(sound(file));
  audio.volume = Math.min(1, volume * masterVolume * (rhythm ? rhythmVolume : 1));
  fallbackAudio.set(audio, { volume, rhythm });
  const cleanup = () => fallbackAudio.delete(audio);
  audio.addEventListener('ended', cleanup, { once: true });
  audio.addEventListener('error', cleanup, { once: true });
  audio.play().catch(cleanup);
  return audio;
}

const state = {
  leverOpen: false,
  current: 'hub',
  history: [],
  // true immediate predecessor node, tracked separately from `history`
  // because scripted autoAdvance jumps deliberately don't push onto history
  // (to avoid a "back" bounce loop) — history's top can't be trusted to name
  // the node just left when the last hop was one of those jumps
  prevNode: null,
  tablo: [null, null, null, null],
  circuitGreen: false,
  cableButtons: [null, null, null, null, null, null, null, null],
  cablesSolved: false,
  towerButtons: new Array(25).fill(false),
  towerSolved: false,
  // minimap: the pin the player last passed through, and every pin seen so far
  mapNode: null,
  explored: []
};

// ---- Looping ambience beds, crossfaded per node (2s per the spec) ----
const AMBIENT_FADE_MS = 2000;
const AMBIENT_MASTER_VOL = Math.pow(10, -10 / 20); // -10dB overall level for every ambient bed
const AMBIENT_QUIET_VOL = 0.4 * AMBIENT_MASTER_VOL;
// finalNoise specifically is +10dB on top of AMBIENT_MASTER_VOL (net: back
// to unity gain at its loudest, frame 12) — everything else stays at the
// -10dB baseline above.
const FINAL_NOISE_BOOST = Math.pow(10, 10 / 20);

const AMBIENT_FILES = {
  cave: 'cave ambience.ogg',
  seaWind: 'sea wind.ogg',
  seaWaves: 'sea waves.ogg',
  buzz: 'buzz.ogg',
  greenhouseWind: 'greenhouse wind.ogg',
  finalNoise: 'final noise.ogg'
};

const CAVE_NODES = new Set([
  'hub', 'first_portal', 'second_door', 'lever_view', 'third_gate',
  'tunnel1_a_front', 'tunnel1_a_back', 'tunnel1_b_front', 'tunnel1_b_back',
  'tunnel2_1_1', 'tunnel2_1_2', 'tunnel2_2_1', 'tunnel2_2_2',
  'tunnel3_1_1', 'tunnel3_1_2', 'tunnel3_2_1', 'tunnel3_2_2',
  'room2_1_1', 'room2_1_2', 'room2_1_3', 'room2_1_5', 'room2_2_1',
  'cables_1', 'cables_2a', 'cables_2b', 'cables_3',
  'lift_1_1', 'lift_1_2', 'lift_2_1', 'lift_2_2', 'lift_panel', 'lift_3_1'
]);
const SEA_WIND_NODES = new Set([
  'beach_a_front', 'beach_a_back', 'beach_b_front', 'beach_b_back', 'beach_b_left', 'beach_b_right',
  'ezh_inside', 'ezh_inside2', 'ezh_mayak', 'ezh_sea', 'storgage_view'
]);
const SEA_WAVES_FULL = new Set(['beach_b_front', 'beach_b_back', 'beach_b_left', 'beach_b_right', 'ezh_sea']);
const SEA_WAVES_QUIET = new Set(['beach_a_front', 'ezh_inside', 'ezh_inside2', 'ezh_mayak']);
const BUZZ_FULL = new Set(['room2_1_1', 'room2_1_2', 'room2_1_3', 'room2_1_5', 'room2_2_1']);
const BUZZ_QUIET = new Set(['lift_1_1', 'lift_1_2', 'tunnel2_2_1', 'tunnel2_2_2']);
const GREENHOUSE_WIND_FULL = new Set(['greenhouse_2_1', 'greenhouse_2_2', 'greenhouse_3_1', 'greenhouse_3_2', 'greenhouse_3_4', 'greenhouse_4_1']);
const GREENHOUSE_WIND_QUIET = new Set(['greenhouse_1_1']);
// greenhouseWind also plays (at the same "full" level) throughout the
// tower/towerlift zone — same physical node-ID set as MUSIC_INDUSTRIAL_NODES,
// kept as its own constant since this one's about the ambient system, not music.
const TOWER_NODES = new Set([
  'tower_1_1', 'tower_1_2', 'tower_1_4', 'tower_2_1', 'tower_2_2', 'tower_3_1', 'tower_4_1',
  'towerlift_1_1', 'towerlift_1_2', 'towerlift_2_1'
]);

// ---- Music beds, one per zone (at most one active at a time — the zone
// sets below are disjoint by construction), 4s fade in / 2s fade out per
// the spec (asymmetric, unlike the ambience beds' symmetric 2s crossfade) ----
const MUSIC_FADE_IN_MS = 10000;
const MUSIC_FADE_OUT_MS = 2000;
const MAP_AUDIO_FADE_MS = 1000;
const MUSIC_BARBERSHOP_VOL = Math.pow(10, -7 / 20); // barbershop track is 7dB quieter than the other 3
const MUSIC_JAZZ_VOL = Math.pow(10, -7 / 20); // jazz track is also 7dB quieter than its original level

const MUSIC_FILES = {
  jazz: 'playing jazz in the metropolis.ogg',
  barbershop: 'capitals barbershop.ogg',
  greenhouse: 'greenhouse floor 264.ogg',
  industrial: 'industrial ash.ogg',
  // 'final music.ogg' removed from the mix entirely per the user — the
  // ending sequence (final_1..12) is scored by finalNoise (ambience) alone
  // now. 'ending' is still loaded here (so its buffer is decoded and ready)
  // but is no longer part of the zone system below — see openEndingMenu()/
  // playEndingFromStart(), it's triggered as a one-off hard restart instead.
  ending: 'final ending.ogg',
  map: 'map noise.ogg'
};

const MUSIC_JAZZ_NODES = new Set([
  'storgage_view', 'ezh_inside', 'ezh_inside2', 'ezh_sea', 'ezh_mayak',
  'beach_a_front', 'beach_a_back', 'beach_b_front', 'beach_b_back', 'beach_b_left', 'beach_b_right'
]);
const MUSIC_BARBERSHOP_NODES = new Set([
  'room2_1_1', 'room2_1_2', 'room2_1_3', 'room2_1_5', 'room2_2_1',
  'cables_1', 'cables_2a', 'cables_2b', 'cables_3',
  'lift_1_1', 'lift_1_2', 'lift_2_1', 'lift_2_2', 'lift_panel', 'lift_3_1'
]);
const MUSIC_GREENHOUSE_NODES = new Set([
  'greenhouse_1_1', 'greenhouse_2_1', 'greenhouse_2_2',
  'greenhouse_3_1', 'greenhouse_3_2', 'greenhouse_3_4', 'greenhouse_4_1'
]);
const MUSIC_INDUSTRIAL_NODES = new Set([
  'tower_1_1', 'tower_1_2', 'tower_1_4', 'tower_2_1', 'tower_2_2', 'tower_3_1', 'tower_4_1',
  'towerlift_1_1', 'towerlift_1_2', 'towerlift_2_1'
]);

// Web Audio API, not plain <audio loop> — HTMLMediaElement looping has to
// seek-and-reinit the decoder every time it wraps (audible gap at the loop
// point) and pausing/resuming a compressed-codec <audio> element has its own
// ~1s restart latency when a zone is re-entered. A decoded AudioBuffer loops
// sample-accurately with zero gap, and is never paused — only its GainNode's
// volume moves, so re-entering a zone is instant, not a restart.
let audioCtx = null;
let masterGainNode = null, masterVolume = 1;
const MASTER_VOLUME_STORE = 'untorra-master-volume';
let rhythmGainNode = null, rhythmVolume = 1;
const fallbackAudio = new Map();
const ambientTracks = {};

function syncFallbackAudio() {
  for (const [audio, voice] of fallbackAudio) {
    audio.volume = Math.min(1, voice.volume * masterVolume * (voice.rhythm ? rhythmVolume : 1));
  }
}

function setMasterVolume(value, persist = false) {
  if (!Number.isFinite(Number(value))) return;
  const amount = Math.max(0, Math.min(100, Math.round(Number(value))));
  masterVolume = amount / 100;
  if (masterGainNode) {
    const now = audioCtx.currentTime;
    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
    masterGainNode.gain.linearRampToValueAtTime(masterVolume, now + 0.03);
  }
  syncFallbackAudio();
  const slider = document.getElementById('settings-volume');
  if (slider) {
    slider.value = String(amount);
    slider.setAttribute('aria-valuetext', amount + '%');
    slider.style.setProperty('--volume-fill', amount + '%');
  }
  if (persist) {
    try { localStorage.setItem(MASTER_VOLUME_STORE, String(amount)); } catch (error) {}
  }
}

// The source .ogg loops weren't recorded with a matching start/end sample —
// there's a real amplitude jump at the wrap point (measured, not assumed:
// converted each to WAV and diffed first/last samples — "buzz" jumps ~11x
// its typical sample-to-sample step, "cave ambience"/"sea waves" more
// moderately, "sea wind"/"greenhouse wind" barely). AudioBufferSourceNode's
// native loop is sample-accurate (no gap), but it can't paper over a
// discontinuity that's actually in the audio data. Ramping the first/last
// ~15ms of each decoded buffer toward silence makes both edges meet near
// zero instead of jumping — the standard fix for a loop click when the
// source file itself isn't a seamless loop, and short enough to be
// inaudible as its own fade against 6-32s of ambient bed.
function smoothLoopEdges(buffer, fadeSamples) {
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    const n = data.length;
    const fade = Math.min(fadeSamples, Math.floor(n / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      data[i] *= g;
      data[n - 1 - i] *= g;
    }
  }
}

// Shared progress counter behind the "loading NN%" indicator — every
// individual asset load anywhere (ambient/music tracks, render images,
// collider maps, one-shot SFX, menu chrome) registers itself here via
// preloadTrack() before any of them can possibly resolve (everything that
// calls this is invoked synchronously back-to-back from init(), so the
// total is fully accumulated before the first item finishes). A tracked
// promise always settles (success or failure both count as "done") so one
// broken asset can't leave the percentage stuck short of 100.
let preloadTotal = 0;
let preloadDone = 0;
function preloadTrack(promise) {
  preloadTotal++;
  return promise.then(onPreloadItemDone, onPreloadItemDone);
}
function preloadRegister(count) {
  preloadTotal += count;
}
function onPreloadItemDone() {
  preloadDone++;
  renderLoadingPercent();
}

// Runs task factories at a bounded concurrency rather than firing every
// request at once. The old all-at-once burst is what made audio loading
// unreliable — multi-megabyte .ogg files competing with ~150 image
// requests would intermittently fail or get aborted, and back then a
// failed track had no retry and no restart path. Audio deliberately isn't
// routed through this pool: it starts immediately and un-throttled from
// init(), so it wins the bandwidth it needs before the bulk begins.
function runPooled(taskFactories, limit) {
  let next = 0;
  const runner = () => {
    if (next >= taskFactories.length) return Promise.resolve();
    const task = taskFactories[next++];
    return task().catch(() => {}).then(() => {
      onPreloadItemDone();
      return runner();
    });
  };
  const workers = Math.max(1, Math.min(limit, taskFactories.length));
  return Promise.all(Array.from({ length: workers }, runner));
}
const DIGIT_IMAGES = {
  '0': 'assets/menu-text/digit-0.png?v=1',
  '1': 'assets/menu-text/digit-1.png?v=1',
  '2': 'assets/menu-text/digit-2.png?v=1',
  '3': 'assets/menu-text/digit-3.png?v=1',
  '4': 'assets/menu-text/digit-4.png?v=1',
  '5': 'assets/menu-text/digit-5.png?v=1',
  '6': 'assets/menu-text/digit-6.png?v=1',
  '7': 'assets/menu-text/digit-7.png?v=1',
  '8': 'assets/menu-text/digit-8.png?v=1',
  '9': 'assets/menu-text/digit-9.png?v=1',
  '%': 'assets/menu-text/digit-percent.png?v=1',
};
// Composes "NN%" from individual pre-baked digit sprites (same pixel-mosaic
// pipeline as every other menu label) into #loading-percent-slot — there's
// no live web font in this project to just set textContent with, see the
// "Real main menu built" convention every other UI string already follows.
function renderLoadingPercent() {
  const pct = preloadTotal > 0 ? Math.floor((preloadDone / preloadTotal) * 100) : 100;
  const slot = document.getElementById('loading-percent-slot');
  if (!slot) return;
  slot.innerHTML = '';
  (String(pct) + '%').split('').forEach(ch => {
    const img = document.createElement('img');
    img.className = 'menu-img';
    img.src = DIGIT_IMAGES[ch];
    slot.appendChild(img);
  });
}
function stopLoadingIndicator() {
  const indicator = document.getElementById('loading-indicator');
  indicator.classList.add('hidden');
  indicator.hidden = true;
}

// Fetch + decode with retries. A transient failure here used to be fatal
// for that track for the whole session: the .catch just warned, t.source
// stayed null, and nothing anywhere retried or restarted it. With ~200
// requests previously going out at once, the big .ogg files were exactly
// the ones that lost that race — which is what made ambience and music
// seem to load only every other time.
function fetchDecodeAudio(url, attempts = 3) {
  return fetch(url)
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(buf => audioCtx.decodeAudioData(buf))
    .catch(err => {
      if (attempts <= 1) throw err;
      return new Promise(res => setTimeout(res, 400))
        .then(() => fetchDecodeAudio(url, attempts - 1));
    });
}

// Starting a source is kept separate from decoding so a track can be
// restarted later — iOS drops the context (and every live node with it) on
// an interruption, and a source that ended or never started would
// otherwise stay silent for good, since these are started exactly once.
function startTrackSource(t) {
  if (!t.buffer || t.source) return;
  const src = audioCtx.createBufferSource();
  src.buffer = t.buffer;
  src.loop = true;
  src.connect(t.gainNode);
  src.onended = () => { if (t.source === src) t.source = null; };
  src.start(0);
  t.source = src;
}

function ensureTrackSources() {
  for (const key in ambientTracks) startTrackSource(ambientTracks[key]);
  for (const key in musicTracks) startTrackSource(musicTracks[key]);
}

function initAmbientTracks() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGainNode = audioCtx.createGain();
  masterGainNode.gain.value = masterVolume;
  masterGainNode.connect(audioCtx.destination);
  const promises = [];
  for (const key in AMBIENT_FILES) {
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(masterGainNode);
    const t = { gainNode, source: null, buffer: null };
    ambientTracks[key] = t;
    const p = fetchDecodeAudio(sound(AMBIENT_FILES[key]))
      .then(audioBuffer => {
        smoothLoopEdges(audioBuffer, Math.round(audioCtx.sampleRate * 0.015));
        t.buffer = audioBuffer;
        startTrackSource(t);
      })
      .catch(err => console.warn('ambient track failed to load:', key, err));
    promises.push(preloadTrack(p));
  }
  return Promise.all(promises);
}

// Ramps one ambient track's gain to `target` (0..1) over `fadeMs` using the
// AudioParam's own scheduler — sample-accurate, independent of frame rate.
function setAmbient(key, target, fadeMs) {
  const t = ambientTracks[key];
  if (!t) return;
  const now = audioCtx.currentTime;
  const g = t.gainNode.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + fadeMs / 1000);
}

function setRhythmVolume(target, fadeMs = 200) {
  rhythmVolume = target;
  if (rhythmGainNode) {
    const now = audioCtx.currentTime;
    const gain = rhythmGainNode.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + fadeMs / 1000);
  }
  syncFallbackAudio();
}

function updateAmbience(nodeId, fadeMs = AMBIENT_FADE_MS) {
  if (minimapOpen) {
    for (const key in ambientTracks) setAmbient(key, 0, MAP_AUDIO_FADE_MS);
    return;
  }
  setAmbient('cave', CAVE_NODES.has(nodeId) ? AMBIENT_MASTER_VOL : 0, fadeMs);
  setAmbient('seaWind', SEA_WIND_NODES.has(nodeId) ? AMBIENT_MASTER_VOL : 0, fadeMs);
  setAmbient('seaWaves', SEA_WAVES_FULL.has(nodeId) ? AMBIENT_MASTER_VOL : SEA_WAVES_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, fadeMs);
  setAmbient('buzz', BUZZ_FULL.has(nodeId) ? AMBIENT_MASTER_VOL : BUZZ_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, fadeMs);
  setAmbient('greenhouseWind', (GREENHOUSE_WIND_FULL.has(nodeId) || TOWER_NODES.has(nodeId)) ? AMBIENT_MASTER_VOL : GREENHOUSE_WIND_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, fadeMs);

  // Grows louder frame by frame through the ending sequence (final_1..12),
  // peaking at full volume right as final_12 is reached; silent everywhere
  // else, including the true black ending screen (final_13).
  const finalMatch = /^final_(\d+)$/.exec(nodeId);
  const finalN = finalMatch ? parseInt(finalMatch[1], 10) : null;
  const finalNoiseTarget = (finalN >= 1 && finalN <= 12) ? (finalN / 12) * AMBIENT_MASTER_VOL * FINAL_NOISE_BOOST : 0;
  setAmbient('finalNoise', finalNoiseTarget, fadeMs);
}

const musicTracks = {};

function initMusicTracks() {
  const promises = [];
  for (const key in MUSIC_FILES) {
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(masterGainNode);
    const t = { gainNode, source: null, buffer: null };
    musicTracks[key] = t;
    const p = fetchDecodeAudio(musicSound(MUSIC_FILES[key]))
      .then(audioBuffer => {
        if (key === 'map') smoothLoopEdges(audioBuffer, Math.round(audioCtx.sampleRate * 0.015));
        t.buffer = audioBuffer;
        startTrackSource(t);
      })
      .catch(err => console.warn('music track failed to load:', key, err));
    promises.push(preloadTrack(p));
  }
  return Promise.all(promises);
}

// Same gain-ramp mechanism as setAmbient, but fade-in/out durations differ
// per direction (4s in, 2s out) instead of one symmetric crossfade time.
function setMusic(key, target, fadeMs) {
  const t = musicTracks[key];
  if (!t) return;
  const now = audioCtx.currentTime;
  const g = t.gainNode.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + fadeMs / 1000);
}

function updateMusic(nodeId, fadeMs) {
  setMusic('map', minimapOpen ? 1 : 0, MAP_AUDIO_FADE_MS);
  if (minimapOpen) {
    for (const key in musicTracks) if (key !== 'map') setMusic(key, 0, MAP_AUDIO_FADE_MS);
    return;
  }
  const fadeIn = fadeMs ?? MUSIC_FADE_IN_MS, fadeOut = fadeMs ?? MUSIC_FADE_OUT_MS;
  setMusic('jazz', MUSIC_JAZZ_NODES.has(nodeId) ? MUSIC_JAZZ_VOL : 0, MUSIC_JAZZ_NODES.has(nodeId) ? fadeIn : fadeOut);
  setMusic('barbershop', MUSIC_BARBERSHOP_NODES.has(nodeId) ? MUSIC_BARBERSHOP_VOL : 0, MUSIC_BARBERSHOP_NODES.has(nodeId) ? fadeIn : fadeOut);
  setMusic('greenhouse', MUSIC_GREENHOUSE_NODES.has(nodeId) ? 1 : 0, MUSIC_GREENHOUSE_NODES.has(nodeId) ? fadeIn : fadeOut);
  setMusic('industrial', MUSIC_INDUSTRIAL_NODES.has(nodeId) ? 1 : 0, MUSIC_INDUSTRIAL_NODES.has(nodeId) ? fadeIn : fadeOut);
  // 'ending' is deliberately not driven by node membership here — see
  // openEndingMenu()/playEndingFromStart(), triggered once as a hard
  // restart instead of a normal zone crossfade.
}

// Percent-of-source-image (640x480) centers, one [x,y] pair per [row][col],
// measured directly off the user's marked-up reference photo (pixel-detected, not eyeballed).
const TABLO_POINTS = [
  [[33.83, 18.65], [43.20, 18.85], [52.58, 18.85], [61.33, 18.65]],
  [[33.36, 29.27], [42.73, 29.48], [52.27, 29.48], [61.95, 29.69]],
  [[32.42, 40.94], [42.42, 40.94], [52.27, 40.94], [62.27, 40.73]],
  [[31.80, 52.60], [41.95, 52.81], [52.11, 53.02], [62.42, 53.23]]
];
const TABLO_W = 9;
const TABLO_H = 10;

// Play/confirm button on the stand to the right of the panel — barely visible
// in the render, position measured off the user's marked-up reference photo.
const PLAY_POINT = [78.55, 22.70];
const PLAY_W = 7;
const PLAY_H = 7;

// The panel is a 4-note musical sequencer: TABLO_POINTS row 0 is the
// physically topmost row on screen, and per the user's spec "higher on the
// panel = higher note" with notes numbered 1 (lowest) to 4 (highest) — so
// note number = 4 - row. TABLO_SOLUTION[col] is the one correct row for
// that column (read off the user's reference screenshot of the panel with
// the correct buttons lit): col0->row3(note1), col1->row2(note2),
// col2->row0(note4), col3->row1(note3) — sequence heard left-to-right is
// notes [1,2,4,3].
const TABLO_SOLUTION = [3, 2, 0, 1];
const TABLO_NOTE_INTERVAL_MS = 1000;
const TABLO_NOTE_HIGHLIGHT_MS = 375;
const TABLO_NOTE_FADE_MS = 200;

function buildTabloHotspots() {
  const hotspots = [];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      const [px, py] = TABLO_POINTS[row][col];
      hotspots.push({
        x: px - TABLO_W / 2,
        y: py - TABLO_H / 2,
        w: TABLO_W,
        h: TABLO_H,
        imgSpace: true,
        action: 'toggleTablo',
        col, row,
        icon: '',
        label: ''
      });
    }
  }
  hotspots.push({
    x: PLAY_POINT[0] - PLAY_W / 2,
    y: PLAY_POINT[1] - PLAY_H / 2,
    w: PLAY_W,
    h: PLAY_H,
    imgSpace: true,
    action: 'pressPlay',
    interact: true,
    noGlow: true,
    icon: '',
    label: 'Пуск'
  });
  return hotspots;
}

// Button centers for the cables 3 1 puzzle — percent-of-source-image (640x480),
// pixel-detected from the user's red-dot-marked reference photo (same method as TABLO_POINTS).
const CABLES_POINTS = [
  [33.44, 60.42], [42.66, 60.83], [52.34, 61.46], [61.25, 61.88],
  [32.97, 71.67], [42.34, 72.29], [51.72, 72.50], [61.09, 73.12]
];
// sized to the actual button socket (~37px diameter, measured off the render
// via radial texture-edge falloff), not just eyeballed
const CABLES_W = 6;
const CABLES_H = 8;

// Each button cycles null -> red -> orange -> green -> cyan -> magenta -> null.
// One shared glow asset (assets/tablo-glow.png, warm orange/peach) is hue-rotated
// per color via CSS rather than shipping 5 separate glow images.
// sat is tuned per color — the base asset's brightest pixel is quite pale, so a
// plain hue-rotate reads as pink instead of red / as lavender instead of magenta
// once screen+color-dodge brightens it further; extra saturation compensates.
const CABLE_COLORS = [
  { name: 'red', hue: -30, sat: 6 },
  { name: 'orange', hue: 0, sat: 2.2 },
  { name: 'green', hue: 100, sat: 2.2 },
  { name: 'cyan', hue: 170, sat: 2.2 },
  { name: 'magenta', hue: 280, sat: 4 }
];

// Correct combination read off the user's reference screenshot of the lit
// panel — index = button 0-7 (top row left-to-right, then bottom row
// left-to-right, matching CABLES_POINTS), value = index into CABLE_COLORS.
const CABLES_SOLUTION = [0, 2, 3, 0, 3, 4, 4, 1];

function buildCableHotspots() {
  return CABLES_POINTS.map((p, i) => ({
    x: p[0] - CABLES_W / 2,
    y: p[1] - CABLES_H / 2,
    w: CABLES_W,
    h: CABLES_H,
    imgSpace: true,
    action: 'toggleCableButton',
    index: i,
    icon: '',
    label: ''
  }));
}

// Button centers for the tower 4 1 puzzle — 25 buttons in 5 diagonal rows of 5,
// percent-of-source-image (640x480), pixel-detected the same way as CABLES_POINTS.
const TOWER_POINTS = [
  [27.73, 38.44], [35.70, 36.35], [43.20, 34.69], [50.86, 32.40], [58.05, 30.10],
  [29.61, 48.85], [37.27, 46.35], [44.92, 44.69], [52.42, 42.60], [59.77, 40.10],
  [31.02, 58.65], [38.98, 56.77], [46.95, 54.69], [54.14, 52.60], [61.33, 50.31],
  [32.73, 69.06], [40.86, 66.77], [48.20, 64.69], [55.70, 62.40], [63.20, 59.90],
  [34.30, 79.48], [42.27, 76.98], [49.92, 74.48], [57.27, 72.19], [64.77, 70.10]
];
// same measured button size as CABLES_W/H — the sockets are the same size in both renders
const TOWER_W = 6;
const TOWER_H = 8;

// Correct combination read off the user's reference screenshot (lit buttons
// form a diamond) — indices into TOWER_POINTS that must be on; every other
// button must be off. Cross-checked by overlaying TOWER_POINTS on the raw
// render and comparing dot-for-dot, not eyeballed against the screenshot alone.
const TOWER_SOLUTION = [2, 6, 8, 10, 12, 14, 16, 18, 22];

function buildTowerHotspots() {
  return TOWER_POINTS.map((p, i) => ({
    x: p[0] - TOWER_W / 2,
    y: p[1] - TOWER_H / 2,
    w: TOWER_W,
    h: TOWER_H,
    imgSpace: true,
    action: 'toggleTowerButton',
    index: i,
    icon: '',
    label: ''
  }));
}

// Full-screen invisible navigation colliders. Generated from the user's
// hand-painted color-coded reference images (renders/../colliders/), one
// per node, at 160x120: each pixel's value is an index into that node's
// `actions` array (0 = nothing). See assets/colliders/*.png.
// green=left/right (or back/forward, or turn-around — see COLLIDER_KEY),
// blue=forward, yellow=alternate path, red=interact, magenta=sound-only.
const COLLIDER_DATA = {
  "tunnel1_a_back": { map: "assets/colliders/tunnel1_a_back.png?v=4", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel1_a_front", "cursor": "back"}, {"to": "tunnel1_a_front", "cursor": "left"}, {"to": "tunnel1_a_front", "cursor": "right"}] },
  "tunnel1_b_front": { map: "assets/colliders/tunnel1_b_front.png?v=4", actions: [null, {"to": "beach_a_front", "cursor": "front"}, {"to": "tunnel1_b_back", "cursor": "back"}, {"to": "tunnel1_b_back", "cursor": "right"}] },
  "tunnel1_b_back": { map: "assets/colliders/tunnel1_b_back.png?v=4", actions: [null, {"to": "tunnel1_a_back", "cursor": "front"}, {"to": "tunnel1_b_front", "cursor": "back"}, {"to": "tunnel1_b_front", "cursor": "left"}, {"to": "tunnel1_b_front", "cursor": "right"}] },
  "tunnel1_a_front": { map: "assets/colliders/tunnel1_a_front.png?v=4", actions: [null, {"to": "tunnel1_a_back", "cursor": "left"}, {"to": "tunnel1_b_front", "cursor": "front"}, {"to": "tunnel1_a_back", "cursor": "back"}] },
  "beach_a_front": { map: "assets/colliders/beach_a_front.png?v=4", actions: [null, {"to": "beach_b_front", "cursor": "front"}, {"to": "beach_a_back", "cursor": "back"}, {"to": "beach_a_back", "cursor": "left"}, {"to": "beach_a_back", "cursor": "right"}] },
  "beach_a_back": { map: "assets/colliders/beach_a_back.png?v=4", actions: [null, {"to": "tunnel1_b_back", "cursor": "front"}, {"to": "beach_a_front", "cursor": "back"}, {"to": "beach_a_front", "cursor": "left"}, {"to": "beach_a_front", "cursor": "right"}] },
  "beach_b_front": { map: "assets/colliders/beach_b_front.png?v=6", actions: [null, {"to": "beach_b_left", "cursor": "left"}, {"to": "beach_b_right", "cursor": "right"}, {"to": "ezh_inside", "cursor": "front"}, {"to": "beach_a_front", "cursor": "back"}] },
  "beach_b_back": { map: "assets/colliders/beach_b_back.png?v=6", actions: [null, {"to": "beach_a_back", "cursor": "front"}, {"to": "beach_b_right", "cursor": "left"}, {"to": "beach_b_left", "cursor": "right"}, {"to": "beach_b_left", "cursor": "back"}] },
  "beach_b_left": { map: "assets/colliders/beach_b_left.png?v=4", actions: [null, {"to": "beach_b_back", "cursor": "left"}, {"to": "beach_b_front", "cursor": "right"}, {"to": "storgage_view", "cursor": "front"}, {"to": "beach_b_back", "cursor": "back"}] },
  "beach_b_right": { map: "assets/colliders/beach_b_right.png?v=4", actions: [null, {"to": "beach_b_front", "cursor": "left"}, {"to": "beach_b_back", "cursor": "right"}, {"to": "beach_b_front", "cursor": "back"}] },
  "ezh_inside": { map: "assets/colliders/ezh_inside.png?v=4", actions: [null, {"to": "ezh_inside2", "cursor": "front"}, {"to": "beach_b_front", "cursor": "back"}, {"to": "beach_b_front", "cursor": "left"}, {"to": "beach_b_front", "cursor": "right"}] },
  "ezh_inside2": { map: "assets/colliders/ezh_inside2.png?v=4", actions: [null, {"to": "ezh_mayak", "cursor": "front"}, {"to": "ezh_inside", "cursor": "left"}, {"to": "ezh_sea", "cursor": "right"}, {"to": "ezh_inside", "cursor": "back"}] },
  "ezh_mayak": { map: "assets/colliders/ezh_mayak.png?v=5", actions: [null, {"to": "ezh_sea", "cursor": "front"}, {"to": "ezh_inside2", "cursor": "back"}, {"to": "ezh_inside2", "cursor": "left"}, {"to": "ezh_inside2", "cursor": "right"}] },
  "ezh_sea": { map: "assets/colliders/ezh_sea.png", actions: [null, {"to": "ezh_inside2", "cursor": "back"}] },
  "storgage_view": { map: "assets/colliders/storgage_view.png?v=4", actions: [null, {"to": "beach_b_left", "cursor": "back"}, {"to": "beach_b_left", "cursor": "right"}, {"to": "beach_b_left", "cursor": "left"}] },
  "hub": { map: "assets/colliders/hub.png?v=2", actions: [null, {"to": "first_portal", "cursor": "left"}, {"to": "third_gate", "cursor": "right"}, {"to": "second_door", "cursor": "front"}, {"to": "lever_view", "cursor": "front"}] },
  "lever_view": { map: "assets/colliders/lever_view.png?v=4", actions: [null, {"to": "second_door", "cursor": "left"}, {"to": "third_gate", "cursor": "right"}, {"action": "toggleLever", "cursor": "grab"}, {"to": "hub", "cursor": "back"}] },
  "second_door": { map: "assets/colliders/second_door.png?v=4", actions: [null, {"to": "tunnel2_1_1", "cursor": "front"}, {"to": "first_portal", "cursor": "left"}, {"to": "lever_view", "cursor": "right"}, {"to": "hub", "cursor": "back"}] },
  "first_portal": { map: "assets/colliders/first_portal.png?v=5", actions: [null, {"to": "hub", "cursor": "left"}, {"to": "tunnel1_a_front", "cursor": "front"}, {"to": "second_door", "cursor": "right"}, {"to": "hub", "cursor": "back"}] },
  "third_gate__closed": { map: "assets/colliders/third_gate__closed.png?v=7", actions: [null, {"to": "hub", "cursor": "back"}, {"action": "toggleLever", "cursor": "grab"}, {"sound": "door hit.ogg", "cursor": "grab"}, {"to": "hub", "cursor": "right"}, {"to": "second_door", "cursor": "right"}] },
  "third_gate__open": { map: "assets/colliders/third_gate__open.png?v=5", actions: [null, {"to": "hub", "cursor": "back"}, {"to": "tunnel3_1_1", "cursor": "front"}, {"action": "toggleLever", "cursor": "grab"}, {"to": "hub", "cursor": "right"}, {"to": "second_door", "cursor": "left"}] },
  "tunnel2_1_1": { map: "assets/colliders/tunnel2_1_1.png?v=4", actions: [null, {"to": "tunnel2_2_1", "cursor": "front"}, {"to": "tunnel2_1_2", "cursor": "back"}, {"to": "hub", "cursor": "back"}, {"to": "tunnel2_1_2", "cursor": "left"}, {"to": "tunnel2_1_2", "cursor": "right"}] },
  "tunnel2_1_2": { map: "assets/colliders/tunnel2_1_2.png?v=4", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel2_1_1", "cursor": "back"}, {"to": "tunnel2_1_1", "cursor": "left"}, {"to": "tunnel2_1_1", "cursor": "right"}] },
  "tunnel2_2_1": { map: "assets/colliders/tunnel2_2_1.png?v=4", actions: [null, {"to": "room2_1_1", "cursor": "front"}, {"to": "tunnel2_2_2", "cursor": "back"}, {"to": "tunnel2_2_2", "cursor": "left"}, {"to": "tunnel2_2_2", "cursor": "right"}] },
  "tunnel2_2_2": { map: "assets/colliders/tunnel2_2_2.png?v=4", actions: [null, {"to": "tunnel2_1_2", "cursor": "front"}, {"to": "tunnel2_2_1", "cursor": "back"}, {"to": "tunnel2_2_1", "cursor": "left"}, {"to": "tunnel2_2_1", "cursor": "right"}] },
  "room2_1_2": { map: "assets/colliders/room2_1_2.png?v=4", actions: [null, {"to": "tunnel2_2_2", "cursor": "front"}, {"to": "room2_1_1", "cursor": "left"}, {"to": "room2_1_1", "cursor": "right"}] },
  "room2_1_1": { map: "assets/colliders/room2_1_1.png?v=4", actions: [null, {"to": "room2_1_3", "cursor": "right"}, {"to": "room2_1_2", "cursor": "right"}, {"to": "room2_2_1", "cursor": "front"}, {"to": "cables_1", "cursor": "front"}, {"to": "room2_1_5", "cursor": "front"}, {"to": "room2_1_2", "cursor": "back"}, {"to": "room2_1_2", "cursor": "back"}, {"to": "room2_1_2", "cursor": "left"}] },
  "room2_1_3": { map: "assets/colliders/room2_1_3.png", actions: [null, {"to": "room2_1_1", "cursor": "back"}] },
  "room2_1_5": { map: "assets/colliders/room2_1_5.png?v=4", actions: [null, {"to": "room2_1_1", "cursor": "back"}, {"to": "room2_2_1", "cursor": "front"}, {"to": "cables_1", "cursor": "front"}] },
  "room2_2_1": { map: "assets/colliders/room2_2_1.png?v=4", actions: [null, {"to": "lift_1_1", "cursor": "front"}, {"to": "room2_1_1", "cursor": "back"}, {"to": "room2_1_1", "cursor": "left"}, {"to": "cables_1", "cursor": "right"}] },
  "cables_1": { map: "assets/colliders/cables_1.png?v=4", actions: [null, {"to": "room2_1_1", "cursor": "back"}, {"to": "cables_2a", "cursor": "front"}, {"to": "room2_2_1", "cursor": "left"}] },
  "cables_2a": { map: "assets/colliders/cables_2a.png?v=5", actions: [null, {"to": "cables_3", "cursor": "front"}, {"to": "cables_2b", "cursor": "back"}, {"to": "cables_2b", "cursor": "left"}, {"to": "cables_2b", "cursor": "right"}] },
  "cables_2b": { map: "assets/colliders/cables_2b.png?v=5", actions: [null, {"to": "room2_1_1", "cursor": "front"}, {"to": "cables_2a", "cursor": "back"}, {"to": "cables_2a", "cursor": "front"}, {"to": "cables_2a", "cursor": "right"}] },
  "cables_3": { map: "assets/colliders/cables_3.png?v=4", actions: [null, {"to": "cables_2a", "cursor": "back"}, {"to": "cables_2b", "cursor": "left"}, {"to": "cables_2b", "cursor": "right"}] },
  "lift_1_1": { map: "assets/colliders/lift_1_1.png?v=4", actions: [null, {"to": "lift_1_2", "cursor": "left"}, {"to": "lift_2_1", "cursor": "front"}, {"to": "lift_1_2", "cursor": "back"}, {"to": "lift_1_2", "cursor": "right"}] },
  "lift_1_2": { map: "assets/colliders/lift_1_2.png?v=4", actions: [null, {"to": "room2_1_1", "cursor": "front"}, {"to": "lift_1_1", "cursor": "back"}, {"to": "lift_1_1", "cursor": "left"}, {"to": "lift_1_1", "cursor": "right"}] },
  "lift_2_2": { map: "assets/colliders/lift_2_2.png?v=4", actions: [null, {"to": "lift_1_2", "cursor": "front"}, {"to": "lift_2_1", "cursor": "back"}, {"to": "lift_2_1", "cursor": "left"}, {"to": "lift_2_1", "cursor": "right"}] },
  "lift_2_1__green": { map: "assets/colliders/lift_2_1__green.png?v=4", actions: [null, {"to": "lift_2_2", "cursor": "back"}, {"to": "lift_3_1", "cursor": "front"}, {"to": "lift_panel", "cursor": "front"}, {"to": "lift_2_2", "cursor": "left"}, {"to": "lift_2_2", "cursor": "right"}] },
  "lift_2_1__red": { map: "assets/colliders/lift_2_1__red.png?v=4", actions: [null, {"to": "lift_2_2", "cursor": "back"}, {"sound": "door hit.ogg", "cursor": "grab"}, {"to": "lift_panel", "cursor": "front"}] },
  "lift_panel": { map: "assets/colliders/lift_panel.png", actions: [null, {"to": "lift_2_1", "cursor": "back"}] },
  "greenhouse_1_1": { map: "assets/colliders/greenhouse_1_1.png?v=4", actions: [null, {"to": "greenhouse_2_1", "cursor": "front"}, {"to": "lift_3_1", "cursor": "back"}] },
  "lift_3_1__fromGreenhouse": { map: "assets/colliders/greenhouse_1_1.png", actions: [null, {"to": "lift_2_2", "cursor": "front"}, {"to": "greenhouse_1_1", "cursor": "back"}] },
  "greenhouse_2_1": { map: "assets/colliders/greenhouse_2_1.png?v=4", actions: [null, {"to": "greenhouse_3_1", "cursor": "front"}, {"to": "greenhouse_2_2", "cursor": "back"}, {"to": "greenhouse_2_2", "cursor": "left"}, {"to": "greenhouse_2_2", "cursor": "right"}] },
  "greenhouse_2_2": { map: "assets/colliders/greenhouse_2_2.png?v=4", actions: [null, {"to": "greenhouse_1_1", "cursor": "front"}, {"to": "greenhouse_2_1", "cursor": "back"}] },
  "greenhouse_3_1": { map: "assets/colliders/greenhouse_3_1.png?v=4", actions: [null, {"to": "greenhouse_3_2", "cursor": "back"}, {"to": "greenhouse_4_1", "cursor": "front"}, {"to": "greenhouse_3_4", "cursor": "front"}] },
  "greenhouse_3_2": { map: "assets/colliders/greenhouse_3_2.png?v=4", actions: [null, {"to": "greenhouse_2_2", "cursor": "front"}, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "greenhouse_3_4": { map: "assets/colliders/greenhouse_3_4.png?v=4", actions: [null, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "greenhouse_4_1": { map: "assets/colliders/greenhouse_4_1.png?v=4", actions: [null, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "tunnel3_1_1": { map: "assets/colliders/tunnel3_1_1.png?v=4", actions: [null, {"to": "tunnel3_1_2", "cursor": "left"}, {"to": "tunnel3_2_1", "cursor": "front"}, {"to": "lever_view", "cursor": "back"}] },
  "tunnel3_1_2": { map: "assets/colliders/tunnel3_1_2.png?v=5", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel3_1_1", "cursor": "back"}, {"to": "tunnel3_1_1", "cursor": "left"}] },
  "tunnel3_2_1": { map: "assets/colliders/tunnel3_2_1.png?v=4", actions: [null, {"to": "tower_1_1", "cursor": "front"}, {"to": "tunnel3_2_2", "cursor": "back"}, {"to": "tunnel3_2_2", "cursor": "left"}, {"to": "tunnel3_2_2", "cursor": "right"}] },
  "tunnel3_2_2": { map: "assets/colliders/tunnel3_2_2.png?v=4", actions: [null, {"to": "tunnel3_1_2", "cursor": "front"}, {"to": "tunnel3_2_1", "cursor": "back"}, {"to": "tunnel3_2_1", "cursor": "left"}, {"to": "tunnel3_2_1", "cursor": "right"}] },
  "tower_1_1": { map: "assets/colliders/tower_1_1.png?v=4", actions: [null, {"to": "tower_1_2", "cursor": "left"}, {"to": "tower_1_4", "cursor": "right"}, {"to": "tower_2_1", "cursor": "front"}, {"to": "tunnel3_2_1", "cursor": "back"}] },
  "tower_1_2": { map: "assets/colliders/tower_1_2.png?v=5", actions: [null, {"to": "tunnel3_2_2", "cursor": "front"}, {"to": "tower_1_1", "cursor": "back"}, {"to": "tower_1_4", "cursor": "left"}, {"to": "tower_1_1", "cursor": "right"}] },
  "tower_1_4": { map: "assets/colliders/tower_1_4.png?v=4", actions: [null, {"to": "towerlift_1_1", "cursor": "front"}, {"to": "tower_1_1", "cursor": "back"}, {"to": "tower_1_2", "cursor": "right"}, {"to": "tower_1_1", "cursor": "left"}] },
  "tower_2_1": { map: "assets/colliders/tower_2_1.png?v=4", actions: [null, {"to": "tower_3_1", "cursor": "front"}, {"to": "tower_2_2", "cursor": "back"}] },
  "tower_2_2": { map: "assets/colliders/tower_2_2.png?v=4", actions: [null, {"to": "tower_1_2", "cursor": "front"}, {"to": "tower_2_1", "cursor": "back"}, {"to": "tower_2_1", "cursor": "left"}] },
  "tower_3_1": { map: "assets/colliders/tower_3_1.png?v=4", actions: [null, {"to": "tower_4_1", "cursor": "front"}, {"to": "tower_2_2", "cursor": "back"}, {"to": "tower_2_2", "cursor": "left"}, {"to": "tower_2_2", "cursor": "right"}] },
  "tower_4_1": { map: "assets/colliders/tower_4_1.png", actions: [null, {"to": "tower_3_1", "cursor": "back"}] },
  "towerlift_1_1": { map: "assets/colliders/towerlift_1_1.png?v=4", actions: [null, {"to": "towerlift_2_1", "cursor": "front"}, {"to": "towerlift_1_2", "cursor": "back"}, {"to": "towerlift_1_2", "cursor": "left"}, {"to": "towerlift_1_2", "cursor": "right"}] },
  "towerlift_1_2": { map: "assets/colliders/towerlift_1_2.png?v=5", actions: [null, {"to": "tower_1_1", "cursor": "front"}, {"to": "tower_1_4", "cursor": "left"}, {"to": "tower_1_4", "cursor": "right"}, {"to": "tower_1_4", "cursor": "back"}] },
  "towerlift_2_1": { map: "assets/colliders/towerlift_2_1.png?v=4", actions: [null, {"to": "towerlift_1_2", "cursor": "right"}, {"action": "towerliftInteract", "flavor": "Здесь тихо и пусто.", "sound": "button press.ogg", "cursor": "grab"}] },

  // Ending sequence — no hand-painted reference exists for these, every
  // frame is just one uniform "click anywhere to continue" zone (a single
  // solid-color region covering the whole frame), so they all share one
  // synthetic uniform map instead of 12 near-identical painted ones.
  "final_1": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_2", "cursor": "front"}] },
  "final_2": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_3", "cursor": "front"}] },
  "final_3": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_4", "cursor": "front"}] },
  "final_4": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_5", "cursor": "front"}] },
  "final_5": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_6", "cursor": "front"}] },
  "final_6": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_7", "cursor": "front"}] },
  "final_7": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_8", "cursor": "front"}] },
  "final_8": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_9", "cursor": "front"}] },
  "final_9": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_10", "cursor": "front"}] },
  "final_10": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_11", "cursor": "front"}] },
  "final_11": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_12", "cursor": "front"}] },
  "final_12": { map: "assets/colliders/final_uniform.png", actions: [null, {"to": "final_13", "cursor": "front"}] },
};

// third_gate and lift_2_1 have two structurally different collider maps
// depending on state (leverOpen / circuitGreen) — resolve to the right key.
function colliderKeyFor(id) {
  if (id === 'third_gate') return state.leverOpen ? 'third_gate__open' : 'third_gate__closed';
  if (id === 'lift_2_1') return state.circuitGreen ? 'lift_2_1__green' : 'lift_2_1__red';
  // arriving from lift_2_1 -> the scripted elevator ride (no collider, see
  // node.autoAdvance.onlyFrom below); arriving any other way (from
  // greenhouse_1_1, retreating) -> a real stop, reusing greenhouse_1_1's map
  if (id === 'lift_3_1') return state.history[state.history.length - 1] === 'lift_2_1' ? 'lift_3_1' : 'lift_3_1__fromGreenhouse';
  return id;
}

const colliderImageCache = {}; // map path -> ImageData | 'loading'

function ensureColliderLoaded(path, onDone) {
  if (colliderImageCache[path]) { if (onDone) onDone(); return; }
  colliderImageCache[path] = 'loading';
  const im = new Image();
  im.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = im.naturalWidth;
    canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(im, 0, 0);
    colliderImageCache[path] = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (onDone) onDone();
  };
  im.onerror = () => {
    // Clear the 'loading' latch instead of leaving it set. A collider whose
    // PNG failed once used to stay "loading" forever, and since
    // resolveColliderAction() bails on that state, every click on that
    // screen silently did nothing for the rest of the session — one dropped
    // request was enough to permanently break a location.
    delete colliderImageCache[path];
    if (onDone) onDone();
  };
  im.src = path;
}

// Bounding box and centroid of every painted region in a collider map, in
// 0..1 of the source frame. The navigation markers place themselves at the
// centroids unless a hand-placed position overrides them, and the authoring
// tools seed their rectangles from the boxes.
const colliderRegionCache = {};
function colliderRegions(key) {
  if (colliderRegionCache[key]) return colliderRegionCache[key];
  const cfg = COLLIDER_DATA[key];
  if (!cfg) return null;
  const data = colliderImageCache[cfg.map];
  if (!data || data === 'loading') { ensureColliderLoaded(cfg.map); return null; }
  const acc = {};
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const v = data.data[(y * data.width + x) * 4];
      if (!v) continue;
      const r = acc[v] || (acc[v] = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0, sx: 0, sy: 0 });
      if (x < r.x0) r.x0 = x;
      if (y < r.y0) r.y0 = y;
      if (x > r.x1) r.x1 = x;
      if (y > r.y1) r.y1 = y;
      r.n++; r.sx += x; r.sy += y;
    }
  }
  const out = {};
  for (const k in acc) {
    const r = acc[k];
    out[k] = {
      box: [r.x0 / data.width, r.y0 / data.height,
            (r.x1 - r.x0 + 1) / data.width, (r.y1 - r.y0 + 1) / data.height],
      centroid: [(r.sx / r.n + 0.5) / data.width, (r.sy / r.n + 0.5) / data.height],
    };
  }
  colliderRegionCache[key] = out;
  return out;
}

// ensureColliderLoaded calls back straight away when a load is already in
// flight, so anything that needs the decoded pixels — not just the request —
// waits for them here instead.
function whenColliderReady(key, fn, tries) {
  if (colliderRegions(key)) { fn(); return; }
  if ((tries || 0) >= 40) return;
  setTimeout(() => whenColliderReady(key, fn, (tries || 0) + 1), 50);
}

// Held right mouse button shows where this screen can be left from. The art
// is the Figma reticle pair: a closed ring for anything straight ahead, a
// half-ring with a tail for the sideways moves, turned so the ring always
// faces the edge the move heads towards.
const NAV_MARKER_ART = { front: 'target', grab: 'target', back: 'side', left: 'side', right: 'side', star: 'star' };
const NAV_MARKER_SPIN = { right: ' scaleX(-1)', back: ' rotate(-90deg)' };
// Hand-placed positions exported from the authoring tool (Shift+N); any
// action missing here falls back to the centroid of its painted region.
const NAV_MARKERS = {"tunnel2_1_1":{"1":[0.4873066271963328,0.36500861045789335],"2":[0.628967934411645,0.6583156086387429],"3":[0.4873066271963328,0.8603157722513088],"4":[0.3531005208530063,0.5],"5":[0.5,0.6126063481675391]},"hub":{"1":[0.14889322814184894,0.562413901823826],"2":[0.8108072806192117,0.562413901823826],"3":[0.49062499999999987,0.562413901823826],"4":[0.6607196154711912,0.562413901823826]},"first_portal":{"1":[0.10173128580631786,0.5422030065285024],"2":[0.5,0.5422030065285024],"3":[0.9086146789606492,0.5422030065285024],"4":[0.5,0.9037987178348424]},"tunnel1_a_front":{"1":[0.3150946815665632,0.5552609442579104],"2":[0.733020040034052,0.4464332460732983],"3":[0.38780495287179156,0.8946567510779317]},"second_door":{"1":[0.48125,0.6071825916230369],"2":[0.07675727918480131,0.6071825916230369],"3":[0.9106723487989162,0.6071825916230369],"4":[0.48125,0.9093886343804534]},"tunnel1_b_front":{"1":[0.5890497377079358,0.5],"2":[0.5890497377079358,0.903382689790576],"3":[0.4375,0.425163612565445]},"beach_a_front":{"1":[0.5,0.5],"2":[0.5,0.9206928498533996],"3":[0.05925229026221537,0.5833333333333334],"4":[0.93125,0.5833333333333334]},"beach_b_front":{"1":[0.06875,0.5166666666666667],"2":[0.921875,0.5166666666666667],"3":[0.4771039207678563,0.3507771596858639],"4":[0.5,0.9125]},"storgage_view":{"1":[0.5,0.9041666666666667],"2":[0.9,0.40400305410122167],"3":[0.09360542704626335,0.3566358470365057]},"beach_b_right":{"1":[0.096875,0.5],"2":[0.8971510969100155,0.5],"3":[0.5,0.9083333333333333]},"beach_b_left":{"1":[0.1032967696661528,0.5],"2":[0.8826897902622154,0.5],"3":[0.5,0.5],"4":[0.5,0.8958333333333334]},"beach_b_back":{"1":[0.7781418725889453,0.6166666666666667],"2":[0.0875,0.6166666666666667],"3":[0.946875,0.6166666666666667],"4":[0.5,0.9041666666666667]},"ezh_inside":{"1":[0.490625,0.3625],"2":[0.5,0.9041666666666667],"3":[0.075,0.5083333333333333],"4":[0.921875,0.5083333333333333]},"ezh_inside2":{"1":[0.6105231269508927,0.5957890215968584],"2":[0.0625,0.5125],"3":[0.928125,0.5125],"4":[0.5,0.9041666666666667]},"ezh_mayak":{"1":[0.2966484902867572,0.5249604602966843],"2":[0.5,0.8778454952006981],"3":[0.5,0.5],"4":[0.5,0.5]},"ezh_sea":{"1":[0.5,0.8940813154450266]},"beach_a_back":{"1":[0.509375,0.5625],"2":[0.5,0.925],"3":[0.900006255320619,0.5625],"4":[0.08158424023498886,0.5625]},"tunnel1_b_back":{"1":[0.4977132642998027,0.5291666666666667],"2":[0.4977132642998027,0.9190335305719921],"3":[0.1,0.5291666666666667],"4":[0.9,0.5291666666666667]},"tunnel1_a_back":{"1":[0.509375,0.5208333333333334],"2":[0.509375,0.8892745146160558],"3":[0.07174462090360383,0.5208333333333334],"4":[0.921875,0.5208333333333334]},"tunnel2_2_1":{"1":[0.484375,0.5],"2":[0.5030715811965811,0.923148148148148],"3":[0.09074770973778462,0.5041666666666667],"4":[0.896875,0.5041666666666667]},"room2_1_1":{"1":[0.9629741193820708,0.6081760882560229],"3":[0.3612648268708981,0.6081760882560229],"4":[0.7159643893280255,0.6081760882560229],"5":[0.4794294752586363,0.16886603523690807],"7":[0.5,0.8890379581151838],"8":[0.05548823049550652,0.6081760882560229]},"cables_1":{"1":[0.3932523065596023,0.9155752345113438],"2":[0.3932523065596023,0.562367064790576],"3":[0.06404197208155961,0.562367064790576]},"cables_2a":{"1":[0.390625,0.5666666666666667],"2":[0.5,0.8988281250000001],"3":[0.07767210144927528,0.5666666666666667],"4":[0.91921857580825,0.5666666666666667]},"cables_3":{"1":[0.5,0.8997634434991273],"2":[0.0716162310470975,0.6569555791884817],"3":[0.9089317590057447,0.6569555791884817]},"cables_2b":{"1":[0.3105049122241908,0.5264350185427575],"2":[0.5,0.9125],"4":[0.8982545986622076,0.5264350185427575]},"room2_2_1":{"1":[0.5628872790839966,0.4166666666666667],"2":[0.5,0.9083333333333333],"4":[0.9246415293851474,0.4166666666666667]},"lift_1_1":{"1":[0.159375,0.425],"2":[0.6697636495409885,0.3902527814136127],"3":[0.5,0.925],"4":[0.903125,0.425]},"lift_2_1__red":{"1":[0.46697574181871176,0.8998772905759164],"3":[0.6131507370892738,0.5369833543692349]},"lift_panel":{"1":[0.4503014976293759,0.9145413987623299]},"lift_2_2":{"1":[0.3611002461864117,0.46500327225130894],"2":[0.5,0.8833333333333333],"3":[0.10625,0.4875],"4":[0.89375,0.4875]},"lift_1_2":{"1":[0.5125,0.4791666666666667],"2":[0.5,0.9041666666666667],"3":[0.096875,0.525],"4":[0.915625,0.525]},"room2_1_2":{"1":[0.5125,0.5916666666666667],"2":[0.04375,0.5916666666666667],"3":[0.946875,0.5916666666666667]},"tunnel2_2_2":{"1":[0.459375,0.45416666666666666],"2":[0.459375,0.8840477748691101],"3":[0.09973157244859612,0.49583333333333335],"4":[0.859375,0.49583333333333335]},"tunnel2_1_2":{"1":[0.471875,0.4708333333333333],"2":[0.471875,0.8536192462914487],"3":[0.09987729026221538,0.5708333333333333],"4":[0.8811272902622154,0.5708333333333333]},"lever_view":{"1":[0.11211677814938677,0.5666666666666667],"2":[0.902189590301003,0.5666666666666667],"4":[0.7955356834929972,0.8934938376052091]},"lift_2_1__green":{"1":[0.49404778203723987,0.9042898868200073],"2":[0.43567080477832515,0.4012837846615556],"3":[0.615625,0.5708333333333333],"4":[0.103125,0.4875],"5":[0.890625,0.4875]},"lift_3_1":{},"greenhouse_1_1":{"1":[0.5,0.453768365677671],"2":[0.5,0.9272714604236345]},"greenhouse_2_1":{"1":[0.5,0.5333333333333333],"2":[0.5,0.9125],"3":[0.05625,0.5333333333333333],"4":[0.94375,0.5333333333333333]},"greenhouse_3_1":{"1":[0.446875,0.9041666666666667],"2":[0.21591192987905428,0.5],"3":[0.8646323213614645,0.6228914430628273]},"greenhouse_4_1":{"1":[0.5,0.9041666666666667]},"greenhouse_3_4":{"1":[0.5,0.9083333333333333]},"greenhouse_3_2":{"1":[0.471875,0.5958333333333333],"2":[0.5,0.8875]},"greenhouse_2_2":{"1":[0.45625,0.42083333333333334],"2":[0.5,0.9083333333333333]},"room2_1_3":{"1":[0.47195124064495997,0.841924373715952]},"third_gate__closed":{"1":[0.5,0.9122561315496103],"4":[0.8999587200180914,0.7109738932982068],"5":[0.18351028128219227,0.6894680916104429]},"third_gate__open":{"1":[0.5,0.89950779886562],"2":[0.5,0.5],"4":[0.9018299235371866,0.5],"5":[0.5,0.5]},"tunnel3_1_1":{"1":[0.1811349596208269,0.4],"2":[0.6533618337696788,0.4267472458551481],"3":[0.45959464856230026,0.9132321618743344]},"tunnel3_2_1":{"1":[0.47355207302763264,0.5],"2":[0.47355207302763264,0.8792764234293196],"3":[0.1,0.525],"4":[0.8626227097377847,0.525]},"tower_1_1":{"1":[0.08719638926596562,0.5239151444281902],"2":[0.9125,0.5239151444281902],"3":[0.3037812655360904,0.5239151444281902],"4":[0.5,0.9170293411867363]},"tower_1_2":{"1":[0.5,0.5],"2":[0.5,0.8958333333333334],"3":[0.07899731764182559,0.5],"4":[0.9327705222449754,0.5]},"tower_2_1":{"1":[0.5,0.4110940764289629],"2":[0.5,0.9291666666666667]},"tower_3_1":{"1":[0.5519378312204253,0.587856539048866],"2":[0.5,0.9],"3":[0.040740040379173094,0.45416666666666666],"4":[0.953125,0.45416666666666666]},"tower_4_1":{"1":[0.5,0.9230205225231752]},"tower_2_2":{"1":[0.5574818427934873,0.3660081260907505],"2":[0.5,0.8794202661431068],"3":[0.07336496464425679,0.4570782886125656]},"tower_1_4":{"1":[0.496875,0.5791666666666667],"2":[0.503125,0.925],"3":[0.95625,0.5916666666666667],"4":[0.046875,0.5916666666666667]},"towerlift_1_1":{"1":[0.5,0.6200834424083772],"2":[0.4875,0.9208333333333333],"3":[0.034375,0.5916666666666667],"4":[0.953125,0.6]},"towerlift_2_1":{"1":[0.90625,0.5]},"towerlift_1_2":{"1":[0.503125,0.5625],"2":[0.0789400610864413,0.5625],"3":[0.920028146546105,0.5625],"4":[0.5,0.9166666666666666]},"tunnel3_2_2":{"1":[0.5,0.4628292702879581],"2":[0.5,0.8825486747382199],"3":[0.040740040379173094,0.5416666666666666],"4":[0.959375,0.5416666666666666]},"tunnel3_1_2":{"1":[0.68125,0.5375],"2":[0.68125,0.9069102857766144],"3":[0.040625,0.5]},"lever_view__locked":{"1":[0.11211677814938677,0.5666666666666667],"2":[0.902189590301003,0.5666666666666667],"4":[0.5359431202018577,0.9186388797993021]},"lever_view__ready":{"1":[0.11211677814938677,0.5666666666666667],"2":[0.902189590301003,0.5666666666666667],"4":[0.5359431202018577,0.9186388797993021]},"towerlift_2_1__locked":{"1":[0.90625,0.5]},"towerlift_2_1__ready":{"1":[0.90625,0.5]},"final_1":{"1":[0.5,0.4396715904868081]},"final_2":{"1":[0.5,0.5]},"final_3":{"1":[0.5,0.5]},"final_4":{"1":[0.5,0.5]},"final_5":{"1":[0.5,0.5]},"final_6":{"1":[0.5,0.5]},"final_7":{"1":[0.5,0.5]},"final_8":{"1":[0.5,0.5]},"final_9":{"1":[0.5,0.5]},"final_10":{"1":[0.5,0.5]},"final_11":{"1":[0.5,0.5]},"final_12":{"1":[0.5,0.5]}};
const NAV_MARKER_HIDES = {"first_portal":{"1":false},"tunnel1_a_front":{"1":true},"tunnel1_b_front":{"3":true},"beach_a_front":{"3":true,"4":true},"storgage_view":{"2":true,"3":true},"tunnel1_b_back":{"3":true,"4":true},"tunnel1_a_back":{"3":true,"4":true},"tunnel2_1_1":{"2":true,"4":true,"5":true},"tunnel2_2_1":{"3":true,"4":true},"lift_1_1":{"1":true,"4":true},"lift_2_2":{"3":true,"4":true},"lift_1_2":{"3":true,"4":true},"tunnel2_2_2":{"3":true,"4":true},"tunnel2_1_2":{"3":true,"4":true},"lift_2_1__green":{"4":true,"5":true},"tunnel3_1_1":{"1":true},"tunnel3_2_1":{"3":true,"4":true},"tower_3_1":{"3":true},"tower_2_2":{"3":true},"tower_1_2":{"4":true},"tunnel3_2_2":{"3":true,"4":true},"tunnel3_1_2":{"3":true},"final_1":{"1":true},"final_2":{"1":true},"final_3":{"1":true},"final_4":{"1":true},"final_5":{"1":true},"final_6":{"1":true},"final_7":{"1":true},"final_8":{"1":true},"final_9":{"1":true},"final_10":{"1":true},"final_11":{"1":true},"final_12":{"1":true},"third_gate__closed":{"5":true},"third_gate__open":{"5":true}};
const NAV_FREE_MARKERS = {"hub":{},"lever_view":{"f1":{"pos":[0.5359375000000001,0.5744791666666668],"cursor":"front"}},"second_door":{},"third_gate__closed":{"f1":{"pos":[0.22108939520624293,0.3638138215165057],"cursor":"front"},"f2":{"pos":[0.5,0.5640065937201476],"cursor":"star"},"f3":{"pos":[0.0836091736872557,0.7109738932982068],"cursor":"left"}},"room2_1_1":{"f1":{"pos":[0.8031110646599778,0.22939892233370499],"cursor":"front"}},"room2_2_1":{},"lift_1_1":{},"lift_2_1__red":{"f1":{"pos":[0.28771501160689456,0.5369833543692349],"cursor":"star"}},"cables_1":{},"cables_2a":{},"cables_3":{},"cables_2b":{},"greenhouse_1_1":{},"greenhouse_2_1":{},"greenhouse_3_1":{},"third_gate__open":{"f1":{"pos":[0.3189080294018039,0.89950779886562],"cursor":"front"},"f2":{"pos":[0.06758306962025332,0.5],"cursor":"left"}},"towerlift_2_1":{"f1":{"pos":[0.4904804208472687,0.4162950575994054],"cursor":"star"}},"lever_view__locked":{"f1":{"pos":[0.5359431202018577,0.5666666666666667],"cursor":"star"}},"lever_view__ready":{"f1":{"pos":[0.5359431202018577,0.3514504219409284],"cursor":"front"}},"towerlift_2_1__locked":{"f1":{"pos":[0.4904804208472687,0.4162950575994054],"cursor":"star"}},"towerlift_2_1__ready":{"f1":{"pos":[0.4904804208472687,0.4162950575994054],"cursor":"front"}},"tunnel3_1_1":{},"tunnel3_2_1":{},"tower_1_1":{},"tower_1_4":{},"towerlift_1_1":{},"tower_4_1":{},"final_1":{},"final_2":{},"final_3":{},"final_4":{},"final_5":{},"final_6":{},"final_7":{},"final_8":{},"final_9":{},"final_10":{},"final_11":{},"final_12":{},"first_portal":{}};
const NAV_MARKER_VARIANTS = {
  lever_view__locked: { node: 'lever_view', ready: false, label: 'lever closed — заблокирован' },
  lever_view__ready: { node: 'lever_view', ready: true, label: 'lever closed — доступен' },
  towerlift_2_1__locked: { node: 'towerlift_2_1', ready: false, label: 'tower lift 2 1 — заблокирован' },
  towerlift_2_1__ready: { node: 'towerlift_2_1', ready: true, label: 'tower lift 2 1 — доступен' },
};
function navMarkerBaseKey(key) {
  return (NAV_MARKER_VARIANTS[key] || {}).node || key;
}
function navMarkerKeyFor(id) {
  if (id === 'lever_view' && !state.leverOpen)
    return state.cablesSolved ? 'lever_view__ready' : 'lever_view__locked';
  if (id === 'towerlift_2_1')
    return state.towerSolved ? 'towerlift_2_1__ready' : 'towerlift_2_1__locked';
  return colliderKeyFor(id);
}

let navMarkersHeld = false;

function navMarkerPositions(key, includeFree = true) {
  const baseKey = navMarkerBaseKey(key);
  const cfg = COLLIDER_DATA[baseKey];
  const regions = colliderRegions(baseKey) || {};
  const placed = NAV_MARKERS[key] || NAV_MARKERS[baseKey] || {};
  const hidden = NAV_MARKER_HIDES[key] || NAV_MARKER_HIDES[baseKey] || {};
  const out = [];
  (cfg ? cfg.actions : []).forEach((a, i) => {
    if (!a || !a.to || hidden[i]) return;
    const p = placed[i] || (regions[i] && regions[i].centroid);
    if (p) out.push({ i, action: a, pos: p });
  });
  if (includeFree) Object.entries(NAV_FREE_MARKERS[key] || NAV_FREE_MARKERS[baseKey] || {}).forEach(([id, m]) => {
    out.push({ i: id, action: { cursor: m.cursor }, pos: m.pos });
  });
  return out;
}

function renderNavMarkers() {
  const layer = document.getElementById('nav-markers');
  if (!layer) return;
  layer.innerHTML = '';
  navMarkerPositions(navMarkerKeyFor(state.current)).forEach(m => {
    const img = document.createElement('img');
    img.className = 'nav-marker';
    img.dataset.direction = m.action.cursor || 'front';
    img.src = 'assets/nav/' + (NAV_MARKER_ART[m.action.cursor] || 'target') + '.png?v=1';
    img.style.left = (m.pos[0] * 100) + '%';
    img.style.top = (m.pos[1] * 100) + '%';
    img.style.transform = 'translate(-50%, -50%)' + (NAV_MARKER_SPIN[m.action.cursor] || '');
    layer.appendChild(img);
  });
}

function refreshNavMarkers() {
  if (!navMarkersHeld) return;
  const nodeId = state.current;
  const markerKey = navMarkerKeyFor(nodeId);
  const colliderKey = navMarkerBaseKey(markerKey);
  renderNavMarkers();
  if (COLLIDER_DATA[colliderKey] && !colliderRegions(colliderKey)) {
    whenColliderReady(colliderKey, () => {
      if (navMarkersHeld && state.current === nodeId && navMarkerKeyFor(state.current) === markerKey) renderNavMarkers();
    });
  }
}

function showNavMarkers() {
  if (navMarkersHeld || !gameStarted || autoAdvancing || minimapOpen) return;
  if (!titleScreen.classList.contains('hidden')) return;
  if (typeof editorMode !== 'undefined' && editorMode) return;
  navMarkersHeld = true;
  refreshNavMarkers();
  document.getElementById('nav-markers').classList.add('show');
  if (tutorialStep === 'directions') {
    clearTimeout(tutorialHoldTimer);
    tutorialHoldTimer = setTimeout(() => {
      if (navMarkersHeld && tutorialStep === 'directions') { tutorialStep = 'done'; refreshTutorial(); }
    }, 300);
  }
}

function hideNavMarkers() {
  clearTimeout(tutorialHoldTimer); tutorialHoldTimer = null;
  if (!navMarkersHeld) return;
  navMarkersHeld = false;
  const layer = document.getElementById('nav-markers');
  if (layer) layer.classList.remove('show');
}

// Shared by click and hover — returns the action at a client-space point, or
// null if there's no collider for the current node / the point misses / the
// map hasn't finished loading yet.
function resolveColliderAction(clientX, clientY) {
  const key = colliderKeyFor(state.current);
  const cfg = COLLIDER_DATA[key];
  if (!cfg) return null;
  const data = colliderImageCache[cfg.map];
  if (!data || data === 'loading') {
    // Kick off (or retry) the load so a screen that lost its map can heal on
    // a later click rather than staying dead. No-op if already in flight.
    ensureColliderLoaded(cfg.map);
    return null;
  }

  const rect = sceneWrap.getBoundingClientRect();
  const scale = Math.max(rect.width / SRC_W, rect.height / SRC_H);
  const scaledW = SRC_W * scale, scaledH = SRC_H * scale;
  const cropX = (scaledW - rect.width) / 2, cropY = (scaledH - rect.height) / 2;
  const srcXpct = ((clientX - rect.left) + cropX) / scale / SRC_W;
  const srcYpct = ((clientY - rect.top) + cropY) / scale / SRC_H;
  if (srcXpct < 0 || srcXpct > 1 || srcYpct < 0 || srcYpct > 1) return null;

  const mx = Math.min(data.width - 1, Math.max(0, Math.floor(srcXpct * data.width)));
  const my = Math.min(data.height - 1, Math.max(0, Math.floor(srcYpct * data.height)));
  const regionId = data.data[(my * data.width + mx) * 4];
  return cfg.actions[regionId] || null;
}

function handleColliderClick(clientX, clientY) {
  if (autoAdvancing) return;
  const action = resolveColliderAction(clientX, clientY);
  if (!action) return;

  if (action.to) navigate(action.to);
  else if (action.action === 'toggleLever') toggleLever();
  else if (action.action === 'towerliftInteract') towerliftInteract(action);
  else if (action.interact) {
    if (action.sound) playOneShot(action.sound);
  }
  else if ('sound' in action) { if (action.sound) playOneShot(action.sound); }
}

// towerlift_2_1's own button: dead/flavor-only until the tower_4_1 grid is
// solved, then becomes the (only) way onward — same scripted hold/fade/
// sound/jump as lift_3_1's auto-ascent, just triggered by a click here
// instead of firing automatically on arrival.
function towerliftInteract(action) {
  if (action.sound) playOneShot(action.sound);
  if (state.towerSolved) {
    stopAutoAdvance();
    startAutoAdvance({ holdMs: 2000, fadeMs: 800, to: 'final_1', sound: 'elevator working.ogg' });
  }
}

// Custom cursor images (renders/../assets/cursors/*.png) matching the same
// front/back/left/right/grab vocabulary as hotspot icons (↑/↻/←/→/✋) — the
// hotspot value points at the drawn fingertip, not the image's top-left.
const CURSOR_CSS = {
  passive: `url("assets/cursors/passive-arrow.png") 0 0, default`,
  front: `url("assets/cursors/front.png") 11 0, pointer`,
  back:  `url("assets/cursors/back.png") 9 0, pointer`,
  left:  `url("assets/cursors/left.png") 0 11, pointer`,
  right: `url("assets/cursors/right.png") 24 11, pointer`,
  grab:  `url("assets/cursors/grab.png") 11 11, pointer`,
};
const ICON_CURSOR = { '↑': 'front', '↻': 'back', '←': 'left', '→': 'right', '✋': 'grab' };

function updateColliderCursor(clientX, clientY) {
  const action = resolveColliderAction(clientX, clientY);
  // Empty pixels use the arrow, with its tip at the pointer position.
  // Painted regions retain their action cursor.
  const cursor = action ? (action.cursor || 'front') : 'passive';
  const cursorStyle = CURSOR_CSS[cursor] || CURSOR_CSS.front;
  if (colliderLayer.style.cursor !== cursorStyle) colliderLayer.style.cursor = cursorStyle;
}

function mkFinal(n) {
  return {
    title: 'Финал',
    image: () => img(`4 final/${n}.jpg`),
    hotspots: [],
    noMinimap: true,
    noVignette: true
  };
}

const nodes = {
  hub: {
    title: 'Хаб',
    image: () => img(state.leverOpen ? 'hub/hub open.jpg' : 'hub/hub closed.jpg'),
    hotspots: []
  },
  lever_view: {
    title: 'Рычаг',
    image: () => img(state.leverOpen ? 'hub/lever opened.jpg' : 'hub/lever closed.jpg'),
    hotspots: [],
    back: 'hub'
  },
  second_door: {
    title: 'Дверь',
    image: () => img(state.leverOpen ? 'hub/2nd open.jpg' : 'hub/2nd closed.jpg'),
    hotspots: [],
    back: 'hub'
  },
  third_gate: {
    title: 'Решётка',
    image: () => img(state.leverOpen ? 'hub/3rd open.jpg' : 'hub/3rd.jpg'),
    hotspots: [],
    back: 'hub',
    flavor: () => state.leverOpen
      ? 'Засов сдвинут рычагом, решётка поддалась.'
      : 'За решёткой темно и тихо. Заперто.'
  },
  first_portal: {
    title: 'Проход',
    image: () => img('hub/1st.jpg'),
    hotspots: [],
    back: 'hub'
  },

  tunnel1_a_front: {
    title: 'Тоннель',
    image: () => img('1/tunnel 1/tunnel1 1 1.jpg'),
    hotspots: []
  },
  tunnel1_a_back: {
    title: 'Тоннель',
    image: () => img('1/tunnel 1/tunnel1 1 2.jpg'),
    hotspots: []
  },
  tunnel1_b_front: {
    title: 'Тоннель',
    image: () => img('1/tunnel 1/tunnel1 2 1.jpg'),
    hotspots: []
  },
  tunnel1_b_back: {
    title: 'Тоннель',
    image: () => img('1/tunnel 1/tunnel1 2 2.jpg'),
    hotspots: []
  },

  beach_a_front: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 1 1.jpg'),
    hotspots: []
  },
  beach_a_back: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 1 2.jpg'),
    hotspots: []
  },
  beach_b_front: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 2 1.jpg'),
    hotspots: []
  },
  beach_b_back: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 2 2.jpg'),
    hotspots: []
  },
  beach_b_left: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 2 3.jpg'),
    hotspots: []
  },
  beach_b_right: {
    title: 'Берег',
    image: () => img('1/beach/1 beach/beach 2 4.jpg'),
    hotspots: []
  },

  ezh_inside: {
    title: 'Передатчик',
    image: () => img('1/beach/ezh (transmitter)/ezh inside.jpg'),
    hotspots: [],
    back: 'beach_b_front'
  },
  ezh_inside2: {
    title: 'Передатчик',
    image: () => img('1/beach/ezh (transmitter)/ezh inside 2.jpg'),
    blinkImage: () => img('1/beach/ezh (transmitter)/ezh inside 2 red.jpg'),
    hotspots: [],
    back: 'ezh_inside',
    // same beacon rhythm as ezh_mayak, audible from here but quieter — flashes
    // this node's own existing red frame in sync with the notes instead of
    // the old generic 650ms alternator
    rhythm: {
      sounds: ['note 1.ogg', 'note 2.ogg', 'note 3.ogg', 'note 4.ogg'],
      noteInterval: 1000,
      flashDuration: 250,
      repeatGap: 3000,
      volume: 0.4
    }
  },
  ezh_sea: {
    title: 'Передатчик',
    image: () => img('1/beach/ezh (transmitter)/ezh sea.jpg'),
    hotspots: [],
    back: 'ezh_inside2',
    rhythm: {
      sounds: ['note 1.ogg', 'note 2.ogg', 'note 3.ogg', 'note 4.ogg'],
      noteInterval: 1000,
      repeatGap: 3000,
      volume: 0.4
    }
  },
  ezh_mayak: {
    title: 'Маяк',
    image: () => img('1/beach/ezh (transmitter)/ezh mayak.jpg'),
    blinkImage: () => img('1/beach/ezh (transmitter)/ezh mayak red.jpg'),
    hotspots: [],
    back: 'ezh_inside2',
    // 4 notes one second apart, red flash for 0.25s synced to each note,
    // then a 3s silent gap before the whole sequence repeats
    rhythm: {
      sounds: ['note 1.ogg', 'note 2.ogg', 'note 3.ogg', 'note 4.ogg'],
      noteInterval: 1000,
      flashDuration: 250,
      repeatGap: 3000
    }
  },

  storgage_view: {
    title: 'Склад',
    image: () => img('1/beach/storage/storage 1.jpg'),
    blinkImage: () => img('1/beach/storage/storage 1 red.jpg'),
    hotspots: [],
    back: 'beach_b_left',
    chapterEnd: true,
    // red 1.125s / passive 1.875s (3s cycle) — storage.ogg is exactly 3s,
    // starts in sync with the red flash each cycle
    rhythm: { sounds: ['storage.ogg'], flashDuration: 1125, repeatGap: 3000 }
  },

  // ---- Act 2: tunnel2 -> room2 -> cables / lift -> greenhouse ----

  tunnel2_1_1: {
    title: 'Второй коридор',
    image: () => img('2/tunnel 2/tunnel2 1 1.jpg'),
    hotspots: []
  },
  tunnel2_1_2: {
    title: 'Второй коридор',
    image: () => img('2/tunnel 2/tunnel2 1 2 lever up.jpg'),
    hotspots: []
  },
  tunnel2_2_1: {
    title: 'Второй коридор',
    image: () => img(state.circuitGreen ? '2/tunnel 2/tunnel2 2 1 green.jpg' : '2/tunnel 2/tunnel2 2 1 red.jpg'),
    hotspots: []
  },
  tunnel2_2_2: {
    title: 'Второй коридор',
    image: () => img('2/tunnel 2/tunnel2 2 2 lever up.jpg'),
    hotspots: []
  },

  room2_1_2: {
    title: 'Круглый зал',
    image: () => img('2/room 2/room2 1 2 red.jpg'),
    hotspots: []
  },
  room2_1_1: {
    title: 'Круглый зал',
    image: () => img(state.circuitGreen ? '2/room 2/room2 1 1 green.jpg' : '2/room 2/room2 1 1 red.jpg'),
    hotspots: []
  },
  room2_1_3: {
    title: 'Окна',
    image: () => img(state.circuitGreen ? '2/room 2/room2 1 3 green.jpg' : '2/room 2/room2 1 3 red.jpg'),
    hotspots: [],
    back: 'room2_1_1'
  },
  room2_1_5: {
    title: 'Круглый зал',
    image: () => img(state.circuitGreen ? '2/room 2/room2 1 5 green.jpg' : '2/room 2/room2 1 5 red.jpg'),
    hotspots: [],
    back: 'room2_1_1'
  },
  room2_2_1: {
    title: 'Круглый зал',
    image: () => img(state.circuitGreen ? '2/room 2/room2 2 1 green.jpg' : '2/room 2/room2 2 1 red.jpg'),
    hotspots: [],
    back: 'room2_1_1'
  },

  cables_1: {
    title: 'Проводка',
    image: () => img(state.circuitGreen ? '2/room 2/cables/cables 1 1 green.jpg' : '2/room 2/cables/cables 1 1 red.jpg'),
    hotspots: [],
    back: 'room2_1_1'
  },
  cables_2a: {
    title: 'Проводка',
    image: () => img('2/room 2/cables/cables 2 1.jpg'),
    hotspots: [],
    back: 'cables_1'
  },
  cables_2b: {
    title: 'Проводка',
    image: () => img(state.circuitGreen ? '2/room 2/cables/cables 2 2 green.jpg' : '2/room 2/cables/cables 2 2 red.jpg'),
    hotspots: []
  },
  cables_3: {
    title: 'Механизм проводов',
    image: () => img('2/room 2/cables/cables 3 1.jpg'),
    // once solved (cablesSolved) the buttons freeze — no more input
    hotspots: () => state.cablesSolved ? [] : buildCableHotspots(),
    cableGlow: true,
    back: 'cables_2b'
  },

  lift_1_1: {
    title: 'Тоннель к лифту',
    image: () => img(state.circuitGreen ? '2/room 2/lift/lift 1 1 green.jpg' : '2/room 2/lift/lift 1 1 red.jpg'),
    hotspots: []
  },
  lift_1_2: {
    title: 'Тоннель к лифту',
    image: () => img(state.circuitGreen ? '2/room 2/lift/lift 1 2 green.jpg' : '2/room 2/lift/lift 1 2 red.jpg'),
    hotspots: []
  },
  lift_2_1: {
    title: 'Тоннель к лифту',
    image: () => img(state.circuitGreen ? '2/room 2/lift/lift 2 1 green.jpg' : '2/room 2/lift/lift 2 1 red.jpg'),
    // explicit hotspot (not the collider) so the panel stays reachable even
    // when circuitGreen is false — the red-state map has no yellow zone for
    // it (only green=turn and magenta=sound-only), and the panel has to be
    // reachable *before* it's solved or the puzzle can never be started.
    // Stays present (click zone included) in both color states; noGlow only
    // hides the visible ring/emoji, never the underlying navigation.
    hotspots: [
      { x: 46, y: 30, w: 30, h: 53, to: 'lift_panel', icon: '✋', label: 'Панель', interact: true, noGlow: true }
    ],
    flavor: () => state.circuitGreen ? '' : 'Дальше темно — механизм обесточен.'
  },
  lift_2_2: {
    title: 'Тоннель к лифту',
    image: () => img(state.circuitGreen ? '2/room 2/lift/lift 2 2 green.jpg' : '2/room 2/lift/lift 2 2 red.jpg'),
    hotspots: []
  },
  lift_panel: {
    title: 'Панель',
    image: () => img(state.circuitGreen ? '2/room 2/lift/lift panel green.jpg' : '2/room 2/lift/lift panel red.jpg'),
    // once solved (circuitGreen) the whole panel goes dead — no more input,
    // the solved combination just sits there lit
    hotspots: () => state.circuitGreen ? [] : buildTabloHotspots(),
    tablo: true,
    back: 'lift_2_1'
  },
  lift_3_1: {
    title: 'Лифт',
    image: () => img('2/room 2/lift/lift 3 1.jpg'),
    hotspots: [],
    back: 'lift_2_1',
    // only auto-advances when arriving from lift_2_1 (the scripted elevator
    // ride up) — arriving from greenhouse_1_1 instead (retreating back down)
    // is a real stop, see colliderKeyFor()'s 'lift_3_1__fromGreenhouse'
    autoAdvance: { holdMs: 2000, fadeMs: 800, to: 'greenhouse_1_1', sound: 'elevator working.ogg', onlyFrom: 'lift_2_1' }
  },

  greenhouse_1_1: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 1 1.jpg'),
    hotspots: [],
    back: 'lift_2_1',
    // mirrors lift_3_1's own auto-advance exactly: arriving here from deeper
    // in the greenhouse (currently only greenhouse_2_2) auto-descends to
    // lift_3_1 without stopping; arriving from lift_3_1 itself (the normal
    // "just rode the elevator up" case) is the one real stop, untouched
    autoAdvance: { holdMs: 2000, fadeMs: 800, to: 'lift_3_1', sound: 'elevator working.ogg', exceptFrom: 'lift_3_1' }
  },
  greenhouse_2_1: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 2 1.jpg'),
    hotspots: []
  },
  greenhouse_2_2: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 2 2.jpg'),
    hotspots: []
  },
  greenhouse_3_1: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 3 1.jpg'),
    hotspots: []
  },
  greenhouse_3_2: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 3 2.jpg'),
    hotspots: []
  },
  greenhouse_3_4: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 3 4.jpg'),
    hotspots: [],
    back: 'greenhouse_3_1'
  },
  greenhouse_4_1: {
    title: 'Оранжерея',
    image: () => img('2/greenhouse/greenhouse 4 1.jpg'),
    hotspots: [],
    back: 'greenhouse_3_1',
    chapterEnd: true
  },

  // ---- Act 3: tunnel3 -> tower / tower lift -> final ----

  tunnel3_1_1: {
    title: 'Третий коридор',
    image: () => img('3/tunnel/tunnel3 1 1.jpg'),
    hotspots: []
  },
  tunnel3_1_2: {
    title: 'Третий коридор',
    image: () => img('3/tunnel/tunnel3 1 2.jpg'),
    hotspots: []
  },
  tunnel3_2_1: {
    title: 'Третий коридор',
    image: () => img('3/tunnel/tunnel3 2 1.jpg'),
    hotspots: []
  },
  tunnel3_2_2: {
    title: 'Третий коридор',
    image: () => img('3/tunnel/tunnel3 2 2.jpg'),
    hotspots: []
  },

  tower_1_1: {
    title: 'Башня',
    image: () => img('3/tower/tower 1 1.jpg'),
    hotspots: []
  },
  tower_1_2: {
    title: 'Башня',
    image: () => img('3/tower/tower 1 2.jpg'),
    hotspots: []
  },
  tower_1_4: {
    title: 'Башня',
    image: () => img('3/tower/tower 1 4.jpg'),
    hotspots: [],
    back: 'tower_1_1'
  },
  tower_2_1: {
    title: 'Башня',
    image: () => img('3/tower/tower 2 1.jpg'),
    hotspots: []
  },
  tower_2_2: {
    title: 'Башня',
    image: () => img('3/tower/tower 2 2.jpg'),
    hotspots: []
  },
  tower_3_1: {
    title: 'Башня',
    image: () => img('3/tower/tower 3 1.jpg'),
    hotspots: []
  },
  tower_4_1: {
    title: 'Вершина башни',
    image: () => img('3/tower/tower 4 1.jpg'),
    // no direct hotspot to final_1 here anymore — the only way onward is
    // solving this grid, then triggering the lift from towerlift_2_1
    hotspots: () => state.towerSolved ? [] : buildTowerHotspots(),
    towerGlow: true,
    back: 'tower_3_1'
  },

  towerlift_1_1: {
    title: 'Лифт башни',
    image: () => img('3/tower/tower lift/tower lift 1 1.jpg'),
    hotspots: []
  },
  towerlift_1_2: {
    title: 'Лифт башни',
    image: () => img('3/tower/tower lift/tower lift 1 2.jpg'),
    hotspots: []
  },
  towerlift_2_1: {
    title: 'Лифт башни',
    image: () => img('3/tower/tower lift/tower lift 2 1.jpg'),
    hotspots: [],
    back: 'towerlift_1_1'
  },

  // ---- Ending sequence ----
  final_1: mkFinal(1),
  final_2: mkFinal(2),
  final_3: mkFinal(3),
  final_4: mkFinal(4),
  final_5: mkFinal(5),
  final_6: mkFinal(6),
  final_7: mkFinal(7),
  final_8: mkFinal(8),
  final_9: mkFinal(9),
  final_10: mkFinal(10),
  final_11: mkFinal(11),
  final_12: {
    title: 'Финал',
    image: () => img('4 final/12.jpg'),
    hotspots: [],
    noMinimap: true,
    noVignette: true
  },
  // pure black — the actual end of the game, reached only by clicking
  // through final_12; no collider entry at all, so nothing happens on
  // click here (a real dead end, not just an unconfirmed one)
  final_13: {
    title: 'Финал',
    image: () => img('4 final/13.jpg'),
    hotspots: [],
    noMinimap: true,
    noVignette: true,
    chapterEnd: true,
    // opens the menu (continue hidden) with the ending theme hard-restarted
    // from 0 — see openEndingMenu()/playEndingFromStart()
    openEndingMenu: true
  }
};

let blinkTimer = null;
let rhythmTimers = [];
let imgA, imgB, activeImg;
let sceneReady = Promise.resolve(true);
let hotspotLayer, tabloLayer, colliderLayer, fadeOverlay, sceneWrap, vignetteEl;
let titleScreen, creditsScreen, newGameBtn, continueBtn, continueImg, creditsBtn, creditsBackBtn, storeBtn;
let settingsScreen, settingsBtn, settingsBackBtn;

function closeSettings() {
  settingsScreen.classList.add('hidden');
  settingsScreen.inert = true;
  titleScreen.inert = false;
  settingsBtn.focus({ preventScroll: true });
}

function initSettings() {
  settingsScreen = document.getElementById('settings-screen');
  settingsBtn = document.getElementById('menu-settings');
  settingsBackBtn = document.getElementById('settings-back');
  const resize = () => settingsScreen.style.setProperty('--settings-unit', (document.getElementById('stage').clientWidth / 640) + 'px');
  resize();
  new ResizeObserver(resize).observe(document.getElementById('stage'));
  settingsBtn.addEventListener('click', () => {
    hideNavMarkers();
    titleScreen.inert = true;
    settingsScreen.inert = false;
    settingsScreen.classList.remove('hidden');
    settingsBackBtn.focus({ preventScroll: true });
  });
  settingsBackBtn.addEventListener('click', closeSettings);
  document.getElementById('settings-volume').addEventListener('input', event => setMasterVolume(event.target.value, true));
}

// Credits-screen links (name credit, "Riley W") swap to a separate
// pre-rendered hover-color image on mouseenter/mouseleave — same "bake the
// color into the PNG, swap the whole image" approach as continueImg's
// active/inactive swap, since image-rendering:pixelated can't survive a
// live CSS color change.
const CREDITS_LINKS = [
  { id: 'credits-img-swan', normal: 'assets/menu-text/credits-matthew-swan.png?v=1', hover: 'assets/menu-text/credits-matthew-swan-hover.png?v=1' },
  { id: 'credits-img-riley', normal: 'assets/menu-text/credits-riley-w.png?v=1', hover: 'assets/menu-text/credits-riley-w-hover.png?v=1' },
];
// true once "new game" has actually been pressed once — gates both the
// "continue" menu item and whether Esc is allowed to pause into the menu
// (nothing to pause into before a game exists)
let gameStarted = false;

// Tutorial progress belongs to this playthrough; pause/resume never resets it.
const TUTORIAL_TEXT_IMAGES = {
  map: { src: 'assets/tutorial/map-text.png?v=1', text: 'press M to open the map' },
  directions: { src: 'assets/tutorial/directions-text.png?v=1', text: 'press rmb to show directions' },
};
const TUTORIAL_HINT_MS = 10000;
let tutorialStep = 'map', tutorialHoldTimer = null;
let tutorialExpiryTimers = {}, tutorialExpiredSteps = new Set();
function refreshTutorial() {
  const hint = document.getElementById('tutorial-hint');
  if (!hint || !titleScreen || !creditsScreen) return;
  const show = gameStarted && tutorialStep !== 'done' && !tutorialExpiredSteps.has(tutorialStep) && !minimapOpen && !autoAdvancing
    && titleScreen.classList.contains('hidden') && creditsScreen.classList.contains('hidden')
    && !(typeof editorMode !== 'undefined' && editorMode) && !nodes[state.current].chapterEnd && !nodes[state.current].noMinimap;
  const tutorial = TUTORIAL_TEXT_IMAGES[tutorialStep];
  if (tutorial) {
    hint.dataset.step = tutorialStep;
    const label = hint.querySelector('.tutorial-copy');
    if (label.getAttribute('src') !== tutorial.src) label.src = tutorial.src;
    if (label.alt !== tutorial.text) label.alt = tutorial.text;
  }
  hint.classList.toggle('show', show);
  hint.setAttribute('aria-hidden', show ? 'false' : 'true');
  if (show && !tutorialExpiryTimers[tutorialStep]) {
    const step = tutorialStep;
    tutorialExpiryTimers[step] = setTimeout(() => {
      tutorialExpiredSteps.add(step);
      delete tutorialExpiryTimers[step];
      refreshTutorial();
    }, TUTORIAL_HINT_MS);
  }
}
function initTutorial() {
  const stage = document.getElementById('stage');
  const resize = () => stage.style.setProperty('--tutorial-unit', (stage.clientWidth / 640) + 'px');
  resize(); new ResizeObserver(resize).observe(stage);
  const observer = new MutationObserver(refreshTutorial);
  for (const el of [titleScreen, creditsScreen, document.body]) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  refreshTutorial();
}

const SRC_W = 640, SRC_H = 480;

// The scene image is rendered with object-fit:cover, which scales the 640x480
// source to fill the container and crops whatever overflows. A hotspot authored
// as a fraction of the SOURCE image therefore needs this conversion to land on
// the right spot in the container once the container's aspect ratio isn't 4:3.
function coverRect(xPct, yPct, wPct, hPct) {
  const cw = sceneWrap.clientWidth, ch = sceneWrap.clientHeight;
  const scale = Math.max(cw / SRC_W, ch / SRC_H);
  const scaledW = SRC_W * scale, scaledH = SRC_H * scale;
  const cropX = (scaledW - cw) / 2, cropY = (scaledH - ch) / 2;
  const px = (xPct / 100) * scaledW - cropX;
  const py = (yPct / 100) * scaledH - cropY;
  return {
    left: px / cw * 100,
    top: py / ch * 100,
    width: (wPct / 100) * scaledW / cw * 100,
    height: (hPct / 100) * scaledH / ch * 100
  };
}

function resolve(fn) { return typeof fn === 'function' ? fn() : fn; }

function stopBlink() {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
}

function stopRhythm() {
  rhythmTimers.forEach(clearTimeout);
  rhythmTimers = [];
}

let autoAdvanceTimers = [];
// True only while a scripted hold/fade/jump is mid-flight. #fade-overlay is
// pointer-events:none, so without this a click during the 2s hold or the
// fade-to-black still reached the collider layer underneath, and whatever
// it hit called render() -> stopAutoAdvance(), which clears the *pending
// jump timer*. The screen had already faded to black, so the fade played
// and then came back to the same place — the jump it was fading for had
// just been cancelled. Self-clearing: render() always calls
// stopAutoAdvance() first, so this can't latch on.
let autoAdvancing = false;
function stopAutoAdvance() {
  autoAdvanceTimers.forEach(clearTimeout);
  autoAdvanceTimers = [];
  autoAdvancing = minimapTravelling;
  if (!minimapTravelling) fadeOverlay.classList.remove('show');
}

// Holds the current frame, fades to black, jumps to `to`, then fades back in.
// Cancelled by stopAutoAdvance() if the player navigates away mid-hold.
function startAutoAdvance({ holdMs, fadeMs, to, sound: soundFile }) {
  autoAdvancing = true;
  if (soundFile) playOneShot(soundFile);
  autoAdvanceTimers.push(setTimeout(() => {
    fadeOverlay.style.transitionDuration = fadeMs + 'ms';
    fadeOverlay.classList.add('show');
    autoAdvanceTimers.push(setTimeout(() => {
      // deliberately not navigate() — this transient node shouldn't sit in
      // history, or "← Назад" from `to` would bounce right back into it and
      // re-trigger the same auto-advance immediately
      state.prevNode = state.current;
      state.current = to;
      render();
      fadeOverlay.classList.remove('show');
    }, fadeMs));
  }, holdMs));
}

// Plays node.rhythm.sounds one after another (noteInterval apart), then waits
// repeatGap after the last note before looping back to the first. If the node
// has a blinkImage, also flashes the scene to it for flashDuration on each
// note (ezh_mayak itself); nodes without one (ezh_inside, ezh_sea — the same
// beacon heard nearby, just quieter) just play the sound on schedule.
// Targets `targetImg` directly rather than the mutable `activeImg` — at the
// moment render() starts this, activeImg may still point at the *previous*
// node's <img> element (it's only reassigned once nextImg's onload fires).
function startRhythm(node, targetImg) {
  const { sounds, noteInterval, flashDuration, repeatGap, volume } = node.rhythm;
  const hasFlash = !!node.blinkImage;
  const normalSrc = hasFlash ? resolve(node.image) : null;
  const redSrc = hasFlash ? resolve(node.blinkImage) : null;

  function playNote(i) {
    playOneShot(sounds[i], volume, true);

    if (hasFlash) {
      targetImg.src = redSrc;
      rhythmTimers.push(setTimeout(() => { targetImg.src = normalSrc; }, flashDuration));
    }

    if (i < sounds.length - 1) {
      rhythmTimers.push(setTimeout(() => playNote(i + 1), noteInterval));
    } else {
      rhythmTimers.push(setTimeout(() => playNote(0), repeatGap));
    }
  }
  playNote(0);
}

function render() {
  const node = nodes[state.current];
  stopBlink();
  stopRhythm();
  stopAutoAdvance();
  stopTabloSequence();
  updateAmbience(state.current);
  updateMusic(state.current);
  setRhythmVolume(minimapOpen || !titleScreen.classList.contains('hidden') ? 0 : 1);
  vignetteEl.style.display = node.noVignette ? 'none' : '';
  document.dispatchEvent(new CustomEvent('untorra:screenchange', { detail: {
    id: state.current, title: node.title, image: resolve(node.image), noVignette: !!node.noVignette
  } }));

  // Only the ten map pins update the minimap; every other screen leaves it
  // showing whichever pin the player came through, which is what makes a
  // corridor read as "still in the hub area".
  if (MINIMAP_NODES[state.current]) {
    state.mapNode = state.current;
    if (!state.explored.includes(state.current)) state.explored.push(state.current);
  }
  if (minimapOpen) renderMinimap();

  // The crossfade swap has to survive two cases where `load` never fires:
  // (1) nextImg already holds this exact URL — assigning the same src is a
  // no-op, so no event — which happens constantly, since nextImg is the
  // previously-shown image and this game is full of A->B->A moves (every
  // "back", every corridor turn-around); (2) the image is already decoded
  // in memory (true for basically everything now that preloadAllAssets()
  // warms every render up front), so it can complete before the handler
  // would ever run. Either one used to leave activeImg pointing at the old
  // element: state advanced, the screen kept showing the previous scene —
  // which reads as "the click did nothing".
  const nextImg = activeImg === imgA ? imgB : imgA;
  let swapped = false;
  let finishScene;
  sceneReady = new Promise(resolve => { finishScene = resolve; });
  const swapToNext = () => {
    if (swapped) return;
    swapped = true;
    if (minimapTravelling) {
      imgA.style.transition = 'none';
      imgB.style.transition = 'none';
    }
    imgA.classList.toggle('active', nextImg === imgA);
    imgB.classList.toggle('active', nextImg === imgB);
    activeImg = nextImg;
    if (minimapTravelling) {
      void nextImg.offsetWidth;
      imgA.style.transition = '';
      imgB.style.transition = '';
    }
    finishScene(true);
  };
  nextImg.onload = swapToNext;
  nextImg.onerror = () => { if (!swapped) { swapped = true; finishScene(false); } };
  nextImg.src = resolve(node.image);
  if (nextImg.complete && nextImg.naturalWidth > 0) swapToNext();

  const colliderCfg = COLLIDER_DATA[colliderKeyFor(state.current)];
  if (colliderCfg) ensureColliderLoaded(colliderCfg.map);

  if (node.autoAdvance) {
    const cameFrom = state.prevNode;
    const allowed = (!node.autoAdvance.onlyFrom || cameFrom === node.autoAdvance.onlyFrom)
      && (!node.autoAdvance.exceptFrom || cameFrom !== node.autoAdvance.exceptFrom);
    if (allowed) startAutoAdvance(node.autoAdvance);
  }

  if (node.rhythm) {
    startRhythm(node, nextImg);
  } else if (node.blinkImage) {
    const normalSrc = resolve(node.image);
    const redSrc = resolve(node.blinkImage);
    let showingRed = false;
    blinkTimer = setInterval(() => {
      showingRed = !showingRed;
      activeImg.src = showingRed ? redSrc : normalSrc;
    }, 650);
  }

  hotspotLayer.innerHTML = '';
  resolve(node.hotspots).forEach(hs => {
    const el = document.createElement('div');
    el.className = 'hotspot' + (hs.interact ? ' interact' : '') + (hs.action === 'toggleTablo' || hs.action === 'toggleCableButton' || hs.action === 'toggleTowerButton' ? ' tablo-btn' : '') + (hs.noGlow ? ' no-glow' : '');
    const rect = hs.imgSpace ? coverRect(hs.x, hs.y, hs.w, hs.h) : { left: hs.x, top: hs.y, width: hs.w, height: hs.h };
    el.style.left = rect.left + '%';
    el.style.top = rect.top + '%';
    el.style.width = rect.width + '%';
    el.style.height = rect.height + '%';
    el.style.cursor = CURSOR_CSS[ICON_CURSOR[hs.icon] || 'grab'];
    el.innerHTML = `<div class="hotspot-glow">${hs.icon}</div>`;
    el.addEventListener('click', () => {
      if (hs.action === 'toggleLever') {
        toggleLever();
      } else if (hs.action === 'toggleTablo') {
        toggleTablo(hs.col, hs.row);
      } else if (hs.action === 'pressPlay') {
        pressPlay();
      } else if (hs.action === 'toggleCableButton') {
        toggleCableButton(hs.index);
      } else if (hs.action === 'toggleTowerButton') {
        toggleTowerButton(hs.index);
      } else if (hs.to) {
        navigate(hs.to);
      }
    });
    hotspotLayer.appendChild(el);
  });

  tabloLayer.innerHTML = '';
  tabloLayer.classList.toggle('cables-mask', !!node.cableGlow);
  if (node.tablo) updateTabloGlow();
  if (node.cableGlow) updateCableGlow();
  if (node.towerGlow) updateTowerGlow();

  refreshNavMarkers();
  if (node.openEndingMenu) openEndingMenu();
  refreshTutorial();
}

function navigate(id) {
  if (!nodes[id]) return;
  state.history.push(state.current);
  state.prevNode = state.current;
  state.current = id;
  render();
}

// ---- Minimap (M) -----------------------------------------------------
// Ten screens act as map pins; every other screen in the game belongs to
// whichever pin the player passed through last, so walking a corridor
// keeps the pin you came from lit. Positions are the mockup's own 640x480
// coordinates — the designer's layout already matches the real node graph
// (verified by BFS over COLLIDER_DATA), so there's nothing to solve at
// runtime beyond framing whatever subset is currently visible.
const MINIMAP_NODES = {
  greenhouse_2_1: { x: 355, y: 79 },
  lift_2_1:       { x: 355, y: 163 },
  cables_2a:      { x: 445, y: 209 },
  ezh_inside2:    { x: 256, y: 196 },
  room2_1_1:      { x: 355, y: 257 },
  beach_a_front:  { x: 257, y: 295 },
  storgage_view:  { x: 155, y: 295 },
  tower_1_1:      { x: 448, y: 307 },
  towerlift_2_1:  { x: 551, y: 307 },
  hub:            { x: 355, y: 351 },
  tower_exit:     { x: 551, y: 387, hint: true }, // Figma 46:113: unknown continuation
};
const MINIMAP_EDGES = [
  ['hub', 'beach_a_front'], ['hub', 'room2_1_1'], ['hub', 'tower_1_1'],
  ['beach_a_front', 'ezh_inside2'], ['beach_a_front', 'storgage_view'],
  ['room2_1_1', 'cables_2a'], ['room2_1_1', 'lift_2_1'],
  ['lift_2_1', 'greenhouse_2_1'], ['tower_1_1', 'towerlift_2_1'],
  ['towerlift_2_1', 'tower_exit'],
];
// Original connector artwork and transforms from Figma frame 46:2.
// Tiles: x, y, size, rotation, opacity, optional local Y reflection.
// These are visual link placements; node adjacency stays in MINIMAP_EDGES.
const MINIMAP_LINK_ART = {
  vertical: 'assets/minimap/link-vertical.png?v=1',
  diagonal: 'assets/minimap/link-diagonal.png?v=1',
};
const MINIMAP_LINKS = [
  { edge: ['hub', 'room2_1_1'], art: 'vertical', tiles: [
    [330.38, 264.88, 50.183, 0, 0.52], [330.38, 315.32, 50.183, 180, 0.4],
  ] },
  { edge: ['room2_1_1', 'lift_2_1'], art: 'vertical', tiles: [
    [330.38, 194.88, 50.183, 0, 0.52], [330.38, 142.88, 50.183, 0, 0.52],
  ] },
  { edge: ['lift_2_1', 'greenhouse_2_1'], art: 'vertical', tiles: [
    [330.38, 92.88, 50.183, 0, 0.52],
  ] },
  { edge: ['beach_a_front', 'storgage_view'], art: 'vertical', tiles: [
    [176.31, 270.42, 50.183, -90, 0.4],
  ] },
  { edge: ['beach_a_front', 'ezh_inside2'], art: 'vertical', tiles: [
    [230.9, 212.31, 50.183, 0, 0.4],
  ] },
  { edge: ['tower_1_1', 'towerlift_2_1'], art: 'vertical', tiles: [
    [462.31, 282.42, 50.183, -90, 0.4], [509.31, 282.42, 50.183, -90, 0.4],
  ] },
  { edge: ['towerlift_2_1', 'tower_exit'], art: 'vertical', tiles: [
    [525.31, 321.42, 50.183, 0, 0.4],
  ] },
  // The Figma rotated wrappers are 60.985px square around 50.309px art.
  { edge: ['hub', 'tower_1_1'], art: 'diagonal', tiles: [
    [378.048, 308.778, 50.309, 14, 0.4],
  ] },
  { edge: ['room2_1_1', 'cables_2a'], art: 'diagonal', tiles: [
    [378.048, 208.778, 50.309, 14, 0.4],
  ] },
  { edge: ['hub', 'beach_a_front'], art: 'diagonal', tiles: [
    [281.138, 307.448, 50.309, 166, 0.4, -1],
  ] },
];

const MINIMAP_LINK_BLUR = 1.5;

function layoutMinimapLink(link) {
  const [x, y, size, rotation, , flipY = 1] = link.tiles[0];
  const angle = rotation * Math.PI / 180;
  const localX = link.art === 'diagonal' ? Math.SQRT1_2 : 0;
  const localY = link.art === 'diagonal' ? -Math.SQRT1_2 * flipY : flipY;
  const axisX = localX * Math.cos(angle) - localY * Math.sin(angle);
  const axisY = localX * Math.sin(angle) + localY * Math.cos(angle);
  const centerX = x + size / 2, centerY = y + size / 2;
  const pitch = size * (link.art === 'diagonal' ? Math.SQRT2 : 1);
  const ends = link.edge.map(id => {
    const node = MINIMAP_NODES[id];
    return {
      distance: (node.x - centerX) * axisX + (node.y - centerY) * axisY,
      inset: minimapStateOf(id) === 'current' ? 24 : 12,
    };
  }).sort((first, second) => first.distance - second.distance);
  const start = ends[0].distance + ends[0].inset;
  const end = ends[1].distance - ends[1].inset;
  const point = (distance, offset) => [
    centerX + axisX * distance - axisY * offset,
    centerY + axisY * distance + axisX * offset,
  ];
  const clip = [point(start, -size / 2), point(end, -size / 2),
                point(end, size / 2), point(start, size / 2)];
  const tiles = [];
  const first = Math.floor((start + pitch / 2) / pitch);
  const last = Math.ceil((end - pitch / 2) / pitch);
  for (let index = first; index <= last; index++) {
    const opacity = link.tiles[Math.max(0, Math.min(link.tiles.length - 1, index))][4];
    tiles.push([x + axisX * pitch * index, y + axisY * pitch * index,
                size, rotation, opacity, flipY]);
  }
  return { tiles, clip };
}

const MINIMAP_NEIGHBOURS = (() => {
  const n = {};
  MINIMAP_EDGES.forEach(([a, b]) => { (n[a] = n[a] || []).push(b); (n[b] = n[b] || []).push(a); });
  return n;
})();
// The still is masked to the ring's own irregular inner shape (masks are
// generated from the ring art, flood-filled from the centre and dilated a
// few px so the seam tucks under the glow) rather than cropped to a
// rounded square, which never sat straight inside the hand-drawn ring.
// Widths are 1.45x the real hole so the still COVERS it on both axes —
// renders are 4:3, so sizing by width alone left the shorter vertical
// side falling short of a square hole, and the uncovered strip read as a
// rectangle poking out (worst on the small `left` holes, which is why it
// only showed once a second pin appeared).
const MINIMAP_THUMB = { current: 0.737, left: 0.393 };
const MINIMAP_LABEL_SCALE = 0.1875;   // 64px render -> Figma's 12px
// Visible rim bottoms in the 118px ring art (alpha >= 32), relative to
// its centre. Use the SAME 5px gap for both frame sizes.
const MINIMAP_RING_FOOT = { current: 39, left: 23 };
const MINIMAP_LABEL_GAP = 5;
const MINIMAP_LABEL_DROP = {
  current: MINIMAP_RING_FOOT.current + MINIMAP_LABEL_GAP,
  left: MINIMAP_RING_FOOT.left + MINIMAP_LABEL_GAP,
};
const MINIMAP_NODE_BOX = 118;         // design px, matches the exported ring art
const MINIMAP_LABEL_ROOM = 40;        // design px of label below the lowest pin
const MINIMAP_TOP_INSET = 0.14;       // keeps pins clear of the "map" caption
const MINIMAP_MAX_FREE = 0.4;         // most empty space zooming out may leave
const MINIMAP_SAFE = 0.1;             // screen margin the map is never allowed into
const MINIMAP_ZOOM_MAX = 4;           // absolute ceiling, for when a single pin is known
// Cells across the stage in the low-res buffer. Matches the menu type's own
// mosaic: assets/menu-text/map.png is 56px wide and #minimap-title shows it
// across 10% of the stage, so both end up with one cell per 640/560 design px.
const MINIMAP_RASTER_W = 560;
// The stills are the only photographic thing on the map, so they get a touch
// of blur on top of the shared low-res pass — enough to sit at the same
// quality as the rest of the UI without a coarser grid of their own.
const MINIMAP_THUMB_BLUR = 0.6;  // buffer px
let minimapOpen = false;
let minimapTravelling = false;
let minimapView = { scale: 1, x: 0, y: 0 };

// The box the map lives in: the whole stage less a safe margin all round,
// with the top edge pushed further down to clear the "map" caption. Zoom
// and panning are both held inside it, so no part of the map can ever sit
// off-screen or flush against an edge.
function minimapFrame() {
  const stage = document.getElementById('stage').getBoundingClientRect();
  if (!stage.width) return null;
  const left = stage.width * MINIMAP_SAFE;
  const top = Math.max(stage.height * MINIMAP_TOP_INSET, stage.height * MINIMAP_SAFE);
  return { stage, left, top,
           w: stage.width * (1 - MINIMAP_SAFE) - left,
           h: stage.height * (1 - MINIMAP_SAFE) - top };
}

function minimapStateOf(id) {
  if (MINIMAP_NODES[id]?.hint) return 'unexplored';
  if (id === state.mapNode) return 'current';
  if (state.explored.includes(id)) return 'left';
  return 'unexplored';
}

// explored pins plus their not-yet-visited neighbours — the "?" circles
function minimapVisible() {
  const vis = new Set(state.explored);
  state.explored.forEach(id => (MINIMAP_NEIGHBOURS[id] || []).forEach(nb => vis.add(nb)));
  return [...vis].filter(id => MINIMAP_NODES[id]);
}

// Zooming out stops once the map would leave more than MINIMAP_MAX_FREE of
// the usable height empty, so it can never shrink to a speck in the middle.
function minimapZoomMin() {
  const box = minimapContentBox();
  const stage = document.getElementById('stage').getBoundingClientRect();
  if (!box || !stage.width) return 0.5;
  const px = stage.width / 640;
  const frameH = stage.height * (1 - MINIMAP_TOP_INSET);
  return (1 - MINIMAP_MAX_FREE) * frameH / ((box.maxY - box.minY) * px);
}

// Zooming in stops where the whole map still fits inside the safe frame —
// there is no view that cuts a pin off the screen. Early on, when only a
// few pins are known, that ceiling is high and the map opens close in.
function minimapZoomMax() {
  const box = minimapContentBox();
  const f = minimapFrame();
  if (!box || !f) return MINIMAP_ZOOM_MAX;
  const px = f.stage.width / 640;
  const bw = (box.maxX - box.minX) * px, bh = (box.maxY - box.minY) * px;
  if (!bw || !bh) return MINIMAP_ZOOM_MAX;
  return Math.max(minimapZoomMin(),
                  Math.min(MINIMAP_ZOOM_MAX, Math.min(f.w / bw, f.h / bh)));
}

function minimapBackdropRect() {
  const box = minimapContentBox();
  const frame = minimapFrame();
  if (!box || !frame) return null;
  const zMin = minimapZoomMin();
  const unit = frame.stage.width / 640 * zMin;
  return {
    left: (box.minX + box.maxX) / 2 - (frame.left + frame.w / 2) / unit,
    top: (box.minY + box.maxY) / 2 - (frame.top + frame.h / 2) / unit,
    width: 640 / zMin,
    height: 480 / zMin,
  };
}

function layoutMinimapBackdrop() {
  const rect = minimapBackdropRect();
  if (!rect) return;
  const bg = document.getElementById('minimap-bg');
  bg.style.left = (rect.left / 640 * 100) + '%';
  bg.style.top = (rect.top / 480 * 100) + '%';
  bg.style.width = (rect.width / 640 * 100) + '%';
  bg.style.height = (rect.height / 480 * 100) + '%';
}

function applyMinimapView() {
  minimapView.scale = Math.max(minimapZoomMin(), Math.min(minimapZoomMax(), minimapView.scale));
  clampMinimapView();
  const v = document.getElementById('minimap-view');
  v.style.transform = 'translate(' + minimapView.x + 'px,' + minimapView.y + 'px) scale(' + minimapView.scale + ')';
  scheduleMinimapPaint();
}

// Design-space box the visible pins occupy. Once the pins and their labels
// are actually in the DOM this switches to their measured extent — the
// guessed label room is only a starting estimate, and reserving a fixed
// strip for labels that are mostly one short line left the map sitting low
// with lopsided margins.
let minimapMeasuredBox = null;
function minimapContentBox() {
  if (minimapMeasuredBox) return minimapMeasuredBox;
  const visible = minimapVisible();
  if (!visible.length) return null;
  const half = MINIMAP_NODE_BOX / 2;
  const xs = visible.map(id => MINIMAP_NODES[id].x);
  const ys = visible.map(id => MINIMAP_NODES[id].y);
  return {
    minX: Math.min(...xs) - half, maxX: Math.max(...xs) + half,
    minY: Math.min(...ys) - half, maxY: Math.max(...ys) + half + MINIMAP_LABEL_ROOM,
  };
}

function measureMinimapContent() {
  const stage = document.getElementById('stage').getBoundingClientRect();
  const parts = document.querySelectorAll('.minimap-node, .minimap-label');
  if (!stage.width || !parts.length) return;
  const px = stage.width / 640, s = minimapView.scale;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  parts.forEach(el => {
    const r = el.getBoundingClientRect();
    minX = Math.min(minX, (r.left   - stage.left - minimapView.x) / s / px);
    maxX = Math.max(maxX, (r.right  - stage.left - minimapView.x) / s / px);
    minY = Math.min(minY, (r.top    - stage.top  - minimapView.y) / s / px);
    maxY = Math.max(maxY, (r.bottom - stage.top  - minimapView.y) / s / px);
  });
  if (isFinite(minX)) minimapMeasuredBox = { minX, minY, maxX, maxY };
}

// Labels size themselves as their images arrive, so re-frame once they have
let minimapRefitQueued = false;
function scheduleMinimapRefit() {
  if (minimapRefitQueued || !minimapOpen) return;
  minimapRefitQueued = true;
  requestAnimationFrame(() => {
    minimapRefitQueued = false;
    if (!minimapOpen) return;
    measureMinimapContent();
    layoutMinimapBackdrop();
    fitMinimapView();
  });
}

// Keeps the map inside the frame: when it's smaller than the viewport it
// can't be dragged off the edges, and when it's zoomed past the viewport it
// can't be pulled away far enough to leave empty space. The top edge also
// stops below the "map" caption so the pins never slide under it.
function clampMinimapView() {
  const box = minimapContentBox();
  const f = minimapFrame();
  if (!box || !f) return;
  const unit = f.stage.width / 640 * minimapView.scale;   // design px -> screen px
  const w = (box.maxX - box.minX) * unit;
  const h = (box.maxY - box.minY) * unit;
  const clamp = (v, a, b) => (a <= b ? Math.min(Math.max(v, a), b) : Math.min(Math.max(v, b), a));
  const x = minimapView.x + box.minX * unit;
  const y = minimapView.y + box.minY * unit;
  const nx = clamp(x, w <= f.w ? f.left : f.left + f.w - w, w <= f.w ? f.left + f.w - w : f.left);
  const ny = clamp(y, h <= f.h ? f.top : f.top + f.h - h, h <= f.h ? f.top + f.h - h : f.top);
  minimapView.x += nx - x;
  minimapView.y += ny - y;
  const backdrop = minimapBackdropRect();
  if (backdrop) {
    minimapView.x = clamp(minimapView.x, f.stage.width - (backdrop.left + backdrop.width) * unit, -backdrop.left * unit);
    minimapView.y = clamp(minimapView.y, f.stage.height - (backdrop.top + backdrop.height) * unit, -backdrop.top * unit);
  }
}

// Frames the visible pins: early on only a handful are known, so this zooms
// in — which is also what brings the backing texture close, since it rides
// the same transform.
function fitMinimapView() {
  const box = minimapContentBox();
  const f = minimapFrame();
  if (!box || !f) return;
  const px = f.stage.width / 640;
  // open as close in as the safe frame allows, which is also the zoom ceiling
  minimapView.scale = minimapZoomMax();
  const unit = px * minimapView.scale;
  minimapView.x = f.left + (f.w - (box.maxX - box.minX) * unit) / 2 - box.minX * unit;
  minimapView.y = f.top + (f.h - (box.maxY - box.minY) * unit) / 2 - box.minY * unit;
  applyMinimapView();
}

// --- low-res pass -----------------------------------------------------
// The map is ordinary DOM (that's what positions the pins, sizes the labels
// and takes the clicks), but it's painted into a small canvas and scaled
// back up unsmoothed, so it reads at the same resolution as the menu type.
// Geometry is read straight off the live boxes — nothing about the layout
// is duplicated here, so the raster can't drift from the DOM behind it.
const minimapImgCache = {};
function minimapImage(src) {
  let im = minimapImgCache[src];
  if (!im) {
    im = minimapImgCache[src] = new Image();
    im.onload = scheduleMinimapPaint;
    im.src = src;
  }
  return im.complete && im.naturalWidth ? im : null;
}

let minimapScratchCv = null;
function minimapScratch(w, h) {
  if (!minimapScratchCv) minimapScratchCv = document.createElement('canvas');
  if (minimapScratchCv.width !== w || minimapScratchCv.height !== h) {
    minimapScratchCv.width = w;
    minimapScratchCv.height = h;
  }
  return minimapScratchCv;
}

let minimapPaintQueued = false;
function scheduleMinimapPaint() {
  if (minimapPaintQueued || !minimapOpen) return;
  minimapPaintQueued = true;
  requestAnimationFrame(() => {
    minimapPaintQueued = false;
    if (minimapOpen) paintMinimapRaster();
  });
}

// Fixed Photoshop reference palette, with a stable 4x4 ordered pattern.
// Dither at display resolution AFTER the shared 560px pixel-mosaic pass:
// otherwise each dot would grow into a large square along with the map.
const MINIMAP_DITHER_PATTERN = new Uint8Array([
  15, 7, 13, 5, 3, 11, 1, 9, 12, 4, 14, 6, 0, 8, 2, 10,
]);
let minimapDither = null, minimapDitherLoading = null;
let minimapLowresCanvas = null, minimapDitherFrame = null;
let minimapDitherPlans = [];

function loadMinimapDither() {
  if (minimapDither) return Promise.resolve(minimapDither);
  if (minimapDitherLoading) return minimapDitherLoading;
  minimapDitherLoading = fetch('assets/minimap/mac-dither.bin?v=1')
    .then(response => {
      if (!response.ok) throw new Error('Dither palette: HTTP ' + response.status);
      return response.arrayBuffer();
    }).then(buffer => {
      const head = new Uint32Array(buffer, 0, 4);
      if (head[0] !== 0x48544944 || head[1] !== 1 || head[3] !== 32)
        throw new Error('Invalid minimap dither data');
      const n = head[2], vertexOffset = 16 + 1024;
      const matrixOffset = vertexOffset + n * 4;
      const seedOffset = matrixOffset + n * 64;
      if (buffer.byteLength !== seedOffset + 32768 * 2)
        throw new Error('Incomplete minimap dither data');
      minimapDither = {
        palette: new Uint32Array(buffer, 16, 256),
        rgb: new Uint8Array(buffer, 16, 1024),
        vertices: new Uint8Array(buffer, vertexOffset, n * 4),
        weights: new Float32Array(buffer, matrixOffset, n * 16),
        seeds: new Uint16Array(buffer, seedOffset, 32768),
        cache: new Map(),
      };
      resetMinimapDitherCache();
      scheduleMinimapPaint();
      return minimapDither;
    }).catch(error => {
      // Keep the map usable and retry on the next open/interaction.
      minimapDitherLoading = null;
      console.warn(error.message);
      return null;
    });
  return minimapDitherLoading;
}

function resetMinimapDitherCache() {
  const d = minimapDither;
  d.cache.clear();
  for (let i = 0; i < 256; i++) {
    const o = i * 4, rgb = (d.rgb[o] << 16) | (d.rgb[o + 1] << 8) | d.rgb[o + 2];
    d.cache.set(rgb, new Uint8Array(16).fill(i)); // retain exact palette colors
  }
}

function minimapDitherPlan(r, g, b) {
  const d = minimapDither, key = (r << 16) | (g << 8) | b;
  const cached = d.cache.get(key);
  if (cached) return cached;
  const cell = d.seeds[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
  const w = d.weights, base = cell * 16;
  const a = Math.max(0, w[base] * r + w[base + 1] * g + w[base + 2] * b + w[base + 3]);
  const c = Math.max(0, w[base + 4] * r + w[base + 5] * g + w[base + 6] * b + w[base + 7]);
  const e = Math.max(0, w[base + 8] * r + w[base + 9] * g + w[base + 10] * b + w[base + 11]);
  const f = Math.max(0, w[base + 12] * r + w[base + 13] * g + w[base + 14] * b + w[base + 15]);
  const scale = 16 / (a + c + e + f || 1);
  const n0 = Math.min(16, Math.floor(a * scale + 1e-6));
  const n1 = Math.min(16 - n0, Math.floor(c * scale + 1e-6));
  const n2 = Math.min(16 - n0 - n1, Math.floor(e * scale + 1e-6));
  const plan = new Uint8Array(16), v = cell * 4;
  plan.fill(d.vertices[v], 0, n0);
  plan.fill(d.vertices[v + 1], n0, n0 + n1);
  plan.fill(d.vertices[v + 2], n0 + n1, n0 + n1 + n2);
  plan.fill(d.vertices[v + 3], n0 + n1 + n2);
  d.cache.set(key, plan);
  return plan;
}

function presentMinimapRaster(source, target, width, height) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (target.width !== w || target.height !== h) { target.width = w; target.height = h; }
  const out = target.getContext('2d', { alpha: false });
  out.imageSmoothingEnabled = false;
  if (!minimapDither) {
    if (target.dataset.palette) delete target.dataset.palette;
    out.clearRect(0, 0, w, h);
    out.drawImage(source, 0, 0, w, h);
    loadMinimapDither();
    return;
  }
  const sw = source.width, sh = source.height;
  const rgba = source.getContext('2d').getImageData(0, 0, sw, sh).data;
  if (minimapDither.cache.size > 32768) resetMinimapDitherCache();
  // Resolve each low-res source pixel once; screen pixels then only pick
  // one of its 16 ordered palette entries, with no per-frame random noise.
  minimapDitherPlans.length = sw * sh;
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const alpha = rgba[i + 3] / 255; // composite against the map's black backdrop
    minimapDitherPlans[j] = minimapDitherPlan(
      Math.round(rgba[i] * alpha), Math.round(rgba[i + 1] * alpha), Math.round(rgba[i + 2] * alpha));
  }
  if (!minimapDitherFrame || minimapDitherFrame.width !== w || minimapDitherFrame.height !== h)
    minimapDitherFrame = out.createImageData(w, h);
  const pixels = new Uint32Array(minimapDitherFrame.data.buffer);
  const palette = minimapDither.palette;
  for (let y = 0, p = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / h)) * sw;
    const row = (y & 3) * 4;
    for (let x = 0; x < w; x++, p++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / w));
      const plan = minimapDitherPlans[sy + sx];
      pixels[p] = palette[plan[MINIMAP_DITHER_PATTERN[row + (x & 3)]]];
    }
  }
  out.putImageData(minimapDitherFrame, 0, 0);
  if (target.dataset.palette !== 'mac') target.dataset.palette = 'mac';
}

function paintMinimapRaster() {
  const target = document.getElementById('minimap-raster');
  const stage = document.getElementById('stage').getBoundingClientRect();
  if (!target || !stage.width) return;
  if (!minimapLowresCanvas) minimapLowresCanvas = document.createElement('canvas');
  const cv = minimapLowresCanvas;
  const cw = MINIMAP_RASTER_W;
  const ch = Math.max(1, Math.round(cw * stage.height / stage.width));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const k = cw / stage.width;                  // screen px -> buffer px
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, cw, ch);
  const box = el => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - stage.left) * k, y: (r.top - stage.top) * k,
             w: r.width * k, h: r.height * k };
  };
  const ready = im => im && im.complete && im.naturalWidth;

  const bgEl = document.getElementById('minimap-bg');
  const bgImg = document.getElementById('minimap-rust');
  if (ready(bgImg)) {
    const b = box(bgEl), rust = box(bgImg);
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.globalAlpha = parseFloat(getComputedStyle(bgEl).opacity);
    ctx.drawImage(bgImg, rust.x, rust.y, rust.w, rust.h);
    ctx.restore();
  }

  // Paint the same Figma image tiles and transforms as the SVG layout.
  const svg = document.getElementById('minimap-edges');
  const sr = svg.getBoundingClientRect();
  const visible = new Set(minimapVisible());
  if (sr.width) {
    ctx.save();
    ctx.translate((sr.left - stage.left) * k, (sr.top - stage.top) * k);
    ctx.scale(sr.width / 640 * k, sr.height / 480 * k);
    MINIMAP_LINKS.forEach(link => {
      if (!link.edge.every(id => visible.has(id))) return;
      const art = minimapImage(MINIMAP_LINK_ART[link.art]);
      if (!art) return;
      const layout = layoutMinimapLink(link);
      ctx.save();
      ctx.beginPath();
      layout.clip.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.clip();
      ctx.filter = 'blur(' + MINIMAP_LINK_BLUR * sr.width / 640 * k + 'px)';
      layout.tiles.forEach(([x, y, size, rotation, opacity, flipY = 1]) => {
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + size / 2, y + size / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.scale(1, flipY);
        ctx.drawImage(art, -size / 2, -size / 2, size, size);
        ctx.restore();
      });
      ctx.restore();
    });
    ctx.restore();
  }

  document.querySelectorAll('.minimap-node').forEach(node => {
    const hole = node.querySelector('.minimap-hole');
    const thumb = hole && hole.querySelector('.minimap-thumb');
    if (hole && ready(thumb)) {
      const maskSrc = (hole.style.maskImage || hole.style.webkitMaskImage || '')
        .replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
      const mask = minimapImage(maskSrc);
      const hb = box(hole);
      // Everything here is snapped to whole buffer pixels: landing the
      // scratch on a fractional offset makes the final blit resample it,
      // which quietly smooths the blocks back out again.
      const hx = Math.round(hb.x), hy = Math.round(hb.y);
      const sw = Math.max(1, Math.round(hb.w)), sh = Math.max(1, Math.round(hb.h));
      if (mask) {
        const sc = minimapScratch(sw, sh);
        const sctx = sc.getContext('2d');
        sctx.clearRect(0, 0, sw, sh);
        const tb = box(thumb);
        sctx.filter = 'blur(' + MINIMAP_THUMB_BLUR + 'px)';
        sctx.drawImage(thumb, Math.round(tb.x) - hx, Math.round(tb.y) - hy,
                       Math.max(1, Math.round(tb.w)), Math.max(1, Math.round(tb.h)));
        sctx.filter = 'none';
        sctx.globalCompositeOperation = 'destination-in';
        sctx.drawImage(mask, 0, 0, sw, sh);
        sctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(sc, hx, hy, sw, sh);
      }
    }
    const ring = node.querySelector('.minimap-ring');
    if (ready(ring)) {
      const rb = box(ring);
      ctx.drawImage(ring, rb.x, rb.y, rb.w, rb.h);
    }
  });

  document.querySelectorAll('.minimap-label').forEach(label => {
    if (!ready(label)) return;
    const b = box(label);
    ctx.drawImage(label, b.x, b.y, b.w, b.h);
  });
  presentMinimapRaster(cv, target, stage.width, stage.height);
}

function renderMinimap() {
  const graph = document.getElementById('minimap-graph');
  const svg = document.getElementById('minimap-edges');
  graph.innerHTML = '';
  svg.innerHTML = '<defs><filter id="minimap-link-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="' + MINIMAP_LINK_BLUR + '"/></filter></defs>';
  const visible = minimapVisible();
  if (!visible.length) return;
  const pos = id => MINIMAP_NODES[id];
  const visSet = new Set(visible);
  MINIMAP_LINKS.forEach((link, index) => {
    if (!link.edge.every(id => visSet.has(id))) return;
    const layout = layoutMinimapLink(link);
    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clip.id = 'minimap-link-clip-' + index;
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', layout.clip.map(point => point.join(',')).join(' '));
    clip.appendChild(polygon);
    svg.querySelector('defs').appendChild(clip);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('clip-path', 'url(#' + clip.id + ')');
    layout.tiles.forEach(([x, y, size, rotation, opacity, flipY = 1]) => {
      const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      image.setAttribute('href', MINIMAP_LINK_ART[link.art]);
      image.setAttribute('x', -size / 2); image.setAttribute('y', -size / 2);
      image.setAttribute('width', size); image.setAttribute('height', size);
      image.setAttribute('opacity', opacity);
      image.setAttribute('filter', 'url(#minimap-link-blur)');
      image.setAttribute('transform', `translate(${x + size / 2} ${y + size / 2}) rotate(${rotation}) scale(1 ${flipY})`);
      image.dataset.edge = link.edge.join(' ');
      group.appendChild(image);
    });
    svg.appendChild(group);
  });

  visible.forEach(id => {
    const st = minimapStateOf(id);
    const p = pos(id);

    const node = document.createElement('div');
    node.className = 'minimap-node' + (st === 'unexplored' ? '' : ' clickable');
    node.dataset.mapId = id;
    node.style.left = (p.x / 640 * 100) + '%';
    node.style.top = (p.y / 480 * 100) + '%';

    if (st !== 'unexplored') {
      const hole = document.createElement('div');
      hole.className = 'minimap-hole';
      hole.style.webkitMaskImage = 'url(assets/minimap/mask-' + st + '.png?v=3)';
      hole.style.maskImage = 'url(assets/minimap/mask-' + st + '.png?v=3)';
      const thumb = document.createElement('img');
      thumb.className = 'minimap-thumb';
      thumb.src = resolve(nodes[id].image);   // follows red/green progress
      thumb.onload = scheduleMinimapPaint;
      thumb.style.width = (MINIMAP_THUMB[st] * 100) + '%';
      hole.appendChild(thumb);
      node.appendChild(hole);
    }

    const ring = document.createElement('img');
    ring.className = 'minimap-ring';
    ring.src = 'assets/minimap/ring-' + st + '.png?v=1';
    ring.onload = scheduleMinimapPaint;
    node.appendChild(ring);

    if (st !== 'unexplored') {
      const label = document.createElement('img');
      label.className = 'minimap-label';
      label.dataset.mapId = id;
      const labelVersion = id === 'tower_1_1' ? 3 : 2;
      label.src = 'assets/minimap/label-' + id + '-' + (st === 'current' ? 'active' : 'passive') + '.png?v=' + labelVersion;
      label.style.left = (p.x / 640 * 100) + '%';
      label.style.top = ((p.y + MINIMAP_LABEL_DROP[st]) / 480 * 100) + '%';
      const sizeIt = () => {
        label.style.width = (label.naturalWidth * MINIMAP_LABEL_SCALE / 640 * 100) + '%';
        scheduleMinimapRefit();
      };
      label.onload = sizeIt;
      if (label.complete && label.naturalWidth) sizeIt();
      graph.appendChild(label);
      node.addEventListener('click', () => minimapTravel(id));
    }
    graph.appendChild(node);
  });
  scheduleMinimapPaint();
}

let minimapOpenRevision = 0;
async function openMinimap() {
  if (minimapOpen || !gameStarted || autoAdvancing || nodes[state.current].noMinimap) return;
  if (!titleScreen.classList.contains('hidden')) return;
  if (!creditsScreen.classList.contains('hidden')) return;
  const revision = ++minimapOpenRevision;
  const map = document.getElementById('minimap');
  map.style.visibility = 'hidden';
  minimapOpen = true;
  setRhythmVolume(0, MAP_AUDIO_FADE_MS);
  updateAmbience(state.current, MAP_AUDIO_FADE_MS);
  updateMusic(state.current, MAP_AUDIO_FADE_MS);
  minimapMeasuredBox = null;
  renderMinimap();
  layoutMinimapBackdrop();
  fitMinimapView();
  refreshTutorial();
  await Promise.all([...map.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
  if (!minimapOpen || revision !== minimapOpenRevision) return;
  map.querySelectorAll('.minimap-label').forEach(label => {
    if (label.naturalWidth) label.style.width = (label.naturalWidth * MINIMAP_LABEL_SCALE / 640 * 100) + '%';
  });
  measureMinimapContent();
  layoutMinimapBackdrop();
  fitMinimapView();
  paintMinimapRaster();
  map.style.visibility = '';
  map.classList.remove('hidden');
}

function closeMinimap({ instant = false } = {}) {
  if (minimapTravelling && !instant) return;
  const wasOpen = minimapOpen;
  minimapOpenRevision++;
  if (minimapOpen && tutorialStep === 'map') tutorialStep = 'directions';
  minimapOpen = false;
  const map = document.getElementById('minimap');
  map.style.visibility = '';
  if (instant) map.style.transition = 'none';
  map.classList.add('hidden');
  if (instant) { void map.offsetWidth; map.style.transition = ''; }
  if (wasOpen) {
    setRhythmVolume(titleScreen.classList.contains('hidden') ? 1 : 0, MAP_AUDIO_FADE_MS);
    updateAmbience(state.current, MAP_AUDIO_FADE_MS);
    updateMusic(state.current, MAP_AUDIO_FADE_MS);
  }
  refreshTutorial();
}

// Fades to black *before* hiding the map, so the screen never flashes the
// room being left behind — the map stays up until the overlay is opaque,
// and by the time it lifts the new location is already rendered.
function minimapTravel(id) {
  if (minimapTravelling) return;
  if (id === state.mapNode) { closeMinimap(); return; }
  minimapTravelling = true;
  autoAdvancing = true;
  const previous = { current: state.current, prevNode: state.prevNode, mapNode: state.mapNode };
  const FADE_MS = 800;
  fadeOverlay.style.transitionDuration = FADE_MS + 'ms';
  fadeOverlay.classList.add('show');
  setTimeout(async () => {
    fadeOverlay.style.transition = 'none';
    void fadeOverlay.offsetWidth;
    fadeOverlay.style.transition = '';
    navigate(id);
    const loaded = await sceneReady;
    if (loaded) closeMinimap({ instant: true });
    else {
      state.history.pop();
      Object.assign(state, previous);
      render();
      await sceneReady;
    }
    await new Promise(requestAnimationFrame);
    minimapTravelling = false;
    autoAdvancing = false;
    fadeOverlay.classList.remove('show');
    refreshTutorial();
  }, FADE_MS);
}

// Wheel zooms about the cursor, left-drag pans. A drag past a few pixels
// suppresses the click so panning across a pin doesn't fast-travel.
function initMinimapControls() {
  const el = document.getElementById('minimap');
  document.getElementById('minimap-rust').addEventListener('load', scheduleMinimapPaint);
  let dragging = false, moved = 0, lastX = 0, lastY = 0;

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(minimapZoomMin(), Math.min(MINIMAP_ZOOM_MAX, minimapView.scale * factor));
    const k = next / minimapView.scale;
    minimapView.x = cx - (cx - minimapView.x) * k;
    minimapView.y = cy - (cy - minimapView.y) * k;
    minimapView.scale = next;
    applyMinimapView();
  }, { passive: false });

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    minimapView.x += dx; minimapView.y += dy;
    applyMinimapView();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  // capture phase: runs before the per-node click handler
  el.addEventListener('click', (e) => {
    if (moved > 5) { e.stopPropagation(); moved = 0; }
  }, true);
}

// "new game" from the Esc menu must actually start over, not just resume
// where "continue" would — restores every mutable field back to its initial
// value (mirrors the literal shape of the `state` object above).
function resetGameState() {
  tutorialStep = 'map';
  clearTimeout(tutorialHoldTimer); tutorialHoldTimer = null;
  Object.values(tutorialExpiryTimers).forEach(clearTimeout);
  tutorialExpiryTimers = {};
  tutorialExpiredSteps.clear();
  state.leverOpen = false;
  state.current = 'hub';
  state.history = [];
  state.prevNode = null;
  state.tablo = [null, null, null, null];
  state.circuitGreen = false;
  state.cableButtons = [null, null, null, null, null, null, null, null];
  state.cablesSolved = false;
  state.towerButtons = new Array(25).fill(false);
  state.towerSolved = false;
  state.mapNode = null;
  state.explored = [];
  // 'ending' isn't part of the normal zone system (see playEndingFromStart),
  // so nothing else ever silences it — without this it would keep playing
  // at full volume over the new session if "new game" is pressed from the
  // ending menu
  if (musicTracks.ending) {
    musicTracks.ending.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    musicTracks.ending.gainNode.gain.value = 0;
  }
}

function toggleLever() {
  // Gated on the cables_3 wire puzzle — until that combination is solved,
  // the lever is inert and just plays its "doesn't work" sound.
  if (!state.cablesSolved) {
    playOneShot('lever doesnt work.ogg');
    return;
  }
  // Pulling the lever DOWN (leverOpen false->true) opens the gate to its
  // right (3rd) -> door-open. Pushing it back UP (true->false) closes the
  // door to its left (2nd) -> door-close. This is about the lever's own
  // physical motion, not which button label happened to be showing.
  playOneShot(state.leverOpen ? 'door close.ogg' : 'door open.ogg');
  state.leverOpen = !state.leverOpen;
  render();
}

function toggleTablo(col, row) {
  playOneShot('beep.ogg');
  state.tablo[col] = state.tablo[col] === row ? null : row;
  updateTabloGlow();
}

// Persistent per-button glow for whatever's currently entered in state.tablo
// (hidden during pressPlay's own animation — see pressPlay — and redrawn
// once it's done: showing the solved combo forever if correct, or nothing
// if state.tablo got reset after a wrong guess).
function updateTabloGlow() {
  tabloLayer.innerHTML = '';
  state.tablo.forEach((row, col) => {
    if (row === null) return;
    const [px, py] = TABLO_POINTS[row][col];
    const rect = coverRect(px, py, 0, 0);
    const d = document.createElement('div');
    d.className = 'tablo-glow';
    d.style.left = rect.left + '%';
    d.style.top = rect.top + '%';
    tabloLayer.appendChild(d);
  });
  // once solved (circuitGreen) the confirm button has nothing left to
  // confirm, so its PNG highlight goes away too — stays lit in the red/
  // unsolved state to help find the button
  if (!state.circuitGreen) {
    const playRect = coverRect(PLAY_POINT[0], PLAY_POINT[1], 0, 0);
    const playGlow = document.createElement('div');
    playGlow.className = 'play-glow';
    playGlow.style.left = playRect.left + '%';
    playGlow.style.top = playRect.top + '%';
    tabloLayer.appendChild(playGlow);
  }
}

let tabloSequenceTimers = [];
function stopTabloSequence() {
  tabloSequenceTimers.forEach(clearTimeout);
  tabloSequenceTimers = [];
}

// Flashes one button's glow at full opacity, holds it for `holdMs`, then
// fades it out over `fadeMs` and removes the element once the transition ends.
function flashTabloButton(col, row, holdMs, fadeMs) {
  const [px, py] = TABLO_POINTS[row][col];
  const rect = coverRect(px, py, 0, 0);
  const d = document.createElement('div');
  d.className = 'tablo-glow';
  d.style.left = rect.left + '%';
  d.style.top = rect.top + '%';
  d.style.transition = `opacity ${fadeMs}ms ease`;
  tabloLayer.appendChild(d);
  tabloSequenceTimers.push(setTimeout(() => {
    d.style.opacity = '0';
    tabloSequenceTimers.push(setTimeout(() => d.remove(), fadeMs));
  }, holdMs));
}

// Musical-sequencer confirm button: plays back the 4 entered notes left to
// right (one note per column, note number = 4 - row since higher on the
// panel is a higher note), 1s apart, flashing each button while its note
// rings and fading the flash out afterward. Only once all 4 slots have had
// their turn is the combination checked against TABLO_SOLUTION — matches
// -> circuitGreen (opens the lift doors); doesn't match -> nothing happens,
// and the player's current button choices are left alone to retry.
function pressPlay() {
  stopTabloSequence();
  // hide the persistent per-button glow for the animation — only the
  // per-note flash (below) shows while the sequence plays back
  tabloLayer.querySelectorAll('.tablo-glow').forEach(el => el.remove());
  state.tablo.forEach((row, col) => {
    if (row === null) return;
    tabloSequenceTimers.push(setTimeout(() => {
      const noteNum = 4 - row;
      playOneShot(`terminal note ${noteNum}.ogg`);
      flashTabloButton(col, row, TABLO_NOTE_HIGHLIGHT_MS, TABLO_NOTE_FADE_MS);
    }, col * TABLO_NOTE_INTERVAL_MS));
  });
  tabloSequenceTimers.push(setTimeout(() => {
    const solved = TABLO_SOLUTION.every((row, col) => state.tablo[col] === row);
    if (solved) {
      // correct: the winning combination stays lit forever, panel goes dead
      playOneShot('elevator open.ogg');
      state.circuitGreen = true;
      render();
    } else {
      // wrong: clear the guess, panel stays interactive for another try
      state.tablo = [null, null, null, null];
      updateTabloGlow();
    }
  }, 4 * TABLO_NOTE_INTERVAL_MS));
}

function toggleCableButton(i) {
  if (state.cablesSolved) return;
  playOneShot('beep.ogg');
  const cur = state.cableButtons[i];
  state.cableButtons[i] = cur === null ? 0 : (cur + 1 >= CABLE_COLORS.length ? null : cur + 1);
  if (CABLES_SOLUTION.every((color, idx) => state.cableButtons[idx] === color)) {
    // correct: freeze the board exactly as-is and unlock the hub lever
    state.cablesSolved = true;
    playOneShot('wires succes.ogg');
    render();
  } else {
    updateCableGlow();
  }
}

function updateCableGlow() {
  tabloLayer.innerHTML = '';
  state.cableButtons.forEach((colorIdx, i) => {
    if (colorIdx === null) return;
    const [px, py] = CABLES_POINTS[i];
    const rect = coverRect(px, py, 0, 0);
    const d = document.createElement('div');
    d.className = 'tablo-glow';
    d.style.left = rect.left + '%';
    d.style.top = rect.top + '%';
    d.style.setProperty('--glow-hue', CABLE_COLORS[colorIdx].hue + 'deg');
    d.style.setProperty('--glow-sat', CABLE_COLORS[colorIdx].sat);
    tabloLayer.appendChild(d);
  });
}

function toggleTowerButton(i) {
  if (state.towerSolved) return;
  playOneShot('beep.ogg');
  state.towerButtons[i] = !state.towerButtons[i];
  const solved = TOWER_POINTS.every((_, idx) =>
    state.towerButtons[idx] === TOWER_SOLUTION.includes(idx));
  if (solved) {
    // freeze the board exactly as-is; towerlift_2_1's own interact zone is
    // what actually reacts to this (see towerliftInteract) for navigation —
    // same success cue as cables_3's wire puzzle
    state.towerSolved = true;
    playOneShot('wires succes.ogg');
    render();
  } else {
    updateTowerGlow();
  }
}

function updateTowerGlow() {
  tabloLayer.innerHTML = '';
  state.towerButtons.forEach((on, i) => {
    if (!on) return;
    const [px, py] = TOWER_POINTS[i];
    const rect = coverRect(px, py, 0, 0);
    const d = document.createElement('div');
    d.className = 'tablo-glow';
    d.style.left = rect.left + '%';
    d.style.top = rect.top + '%';
    // buttons here sit closer together than the cables/tablo grids, so the
    // shared .tablo-glow size (9%/12%) would bleed into neighboring buttons
    d.style.width = '6%';
    d.style.height = '8%';
    d.style.setProperty('--glow-hue', '-30deg');
    d.style.setProperty('--glow-sat', 6);
    tabloLayer.appendChild(d);
  });
}

function repositionOverlays() {
  const node = nodes[state.current];
  if (!node) return;
  const hotspots = resolve(node.hotspots);
  [...hotspotLayer.children].forEach((el, i) => {
    const hs = hotspots[i];
    if (!hs || !hs.imgSpace) return;
    const rect = coverRect(hs.x, hs.y, hs.w, hs.h);
    el.style.left = rect.left + '%';
    el.style.top = rect.top + '%';
    el.style.width = rect.width + '%';
    el.style.height = rect.height + '%';
  });
  if (node.tablo) updateTabloGlow();
  if (node.cableGlow) updateCableGlow();
  if (node.towerGlow) updateTowerGlow();
}

// The menu should be heard over silence, not over whatever ambience/music
// bed the paused node happens to have — quick fade down on pause, and let
// updateAmbience/updateMusic recompute + fade back in for state.current
// on resume (same fade timing they'd use for a normal zone change).
function muteGameAudio(fadeMs = 200) {
  setRhythmVolume(0, fadeMs);
  for (const key in ambientTracks) setAmbient(key, 0, fadeMs);
  for (const key in musicTracks) setMusic(key, 0, fadeMs);
}
function unmuteGameAudio() {
  setRhythmVolume(minimapOpen ? 0 : 1);
  updateAmbience(state.current);
  updateMusic(state.current);
}

function resumeGame() {
  titleScreen.classList.add('hidden');
  unmuteGameAudio();
}

// Hard-restarts 'ending' from sample 0 at full volume, no fade — a fresh
// AudioBufferSourceNode from the already-decoded buffer, since the normal
// persistent-source-never-restarts architecture (see initMusicTracks) is
// exactly what we need to bypass here: the whole point is that this plays
// from the very start every time, not from wherever a long-lived loop
// happens to be.
function playEndingFromStart() {
  const t = musicTracks.ending;
  if (!t || !t.source || !t.source.buffer) return;
  try { t.source.stop(); } catch (e) {}
  const src = audioCtx.createBufferSource();
  src.buffer = t.source.buffer;
  src.loop = true;
  src.connect(t.gainNode);
  src.start(0);
  t.source = src;
  t.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  t.gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
}

// Reaching the true end (final_13) opens the same menu screen instead of a
// distinct scene — but "continue" makes no sense once the story's over, so
// it's hidden (not just disabled) rather than reusing the normal Esc-pause
// path, and the ending theme restarts from the beginning with no fade-in.
// 2s of plain darkness and silence between final_12 and the ending menu —
// no fades either side of that gap, nothing audible during it either.
// Mobile browsers (iOS Safari especially) aggressively suspend the shared
// AudioContext on backgrounding, screen lock, or plain inactivity, and only
// a real user gesture can resume it. Previously the only resume() call in
// the whole game fired once, on the initial "new game" click — any later
// suspension (locking the screen mid-play, backgrounding to check a
// notification) left ambience/music silent for the rest of the session,
// and made one-shot SFX look like the only thing "working" since those go
// through separate <audio> elements outside this context entirely. Calling
// this from every later gesture and on tab-foreground fixes that.
function tryResumeAudio() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  // Resuming isn't enough on its own — anything the interruption killed has
  // to be given a fresh source, or the context runs again in silence.
  ensureTrackSources();
}

// One-shot SFX filenames that aren't reachable by walking node/collider data
// (literals inlined at their playOneShot() call sites) — kept in sync by
// hand with those call sites; see preloadAllAssets().
const EXTRA_ONESHOT_FILES = [
  'lever doesnt work.ogg', 'door open.ogg', 'door close.ogg', 'beep.ogg',
  'elevator open.ogg', 'wires succes.ogg', 'elevator working.ogg',
  'terminal note 1.ogg', 'terminal note 2.ogg', 'terminal note 3.ogg', 'terminal note 4.ogg'
];

// Render images and collider maps are normally fetched lazily, only as the
// player actually navigates to a node — fine on a fast connection, but on
// mobile it means a stall (or, per the reported bug, a silent gap) right as
// a new scene/sound is needed. This walks every node across every
// leverOpen x circuitGreen combination (the only two flags that affect
// which image a node resolves to) plus every collider map and one-shot SFX
// filename, and warms the browser cache for all of them up front.
function preloadAllAssets() {
  const imageUrls = new Set();
  const soundFiles = new Set(EXTRA_ONESHOT_FILES);

  const savedLever = state.leverOpen, savedGreen = state.circuitGreen;
  for (const leverOpen of [false, true]) {
    for (const circuitGreen of [false, true]) {
      state.leverOpen = leverOpen;
      state.circuitGreen = circuitGreen;
      for (const key in nodes) {
        const node = nodes[key];
        if (node.image) imageUrls.add(resolve(node.image));
        if (node.blinkImage) imageUrls.add(resolve(node.blinkImage));
        if (node.rhythm) node.rhythm.sounds.forEach(f => soundFiles.add(f));
        if (node.autoAdvance && node.autoAdvance.sound) soundFiles.add(node.autoAdvance.sound);
      }
    }
  }
  state.leverOpen = savedLever;
  state.circuitGreen = savedGreen;

  const colliderPaths = new Set();
  for (const key in COLLIDER_DATA) {
    const cfg = COLLIDER_DATA[key];
    colliderPaths.add(cfg.map);
    cfg.actions.forEach(a => { if (a && a.sound) soundFiles.add(a.sound); });
  }

  const tasks = [];
  // SFX first: these decode into sfxBuffers, which is what makes a click
  // play instantly instead of paying a fetch+decode at press time.
  soundFiles.forEach(file => {
    tasks.push(() => fetchDecodeAudio(sound(file), 2)
      .then(buffer => { sfxBuffers[file] = buffer; })
      .catch(err => console.warn('sfx failed to load:', file, err)));
  });
  colliderPaths.forEach(path => {
    tasks.push(() => new Promise(res => ensureColliderLoaded(path, res)));
  });
  imageUrls.forEach(url => {
    tasks.push(() => new Promise(res => {
      const im = new Image();
      im.onload = res;
      im.onerror = res;
      im.src = url;
    }));
  });
  preloadRegister(tasks.length);
  return runPooled(tasks, 8);
}

// Menu chrome (background, logo, button labels, cursors) is small but each
// piece still paints independently the moment its own request finishes —
// on a first visit that reads as the menu assembling itself piece by piece
// rather than appearing at once. #title-screen starts at opacity:0 (see
// style.css) and only gets revealed once every one of these has actually
// finished loading (or failed — a broken image shouldn't hold the menu
// hostage forever).
// Every URL here must match byte-for-byte (including the ?v= query) the
// URL actually used elsewhere (index.html src=, or a JS .src= assignment
// like CREDITS_LINKS/continueImg below) — the browser cache keys on the
// full URL, so a preload of the unversioned path doesn't warm the cache
// for a later request of the versioned one. Bit the hover-swap images
// specifically: they have no other DOM reference to load them, so a
// mismatched preload left them as a genuine cold fetch on first hover.
const MENU_UI_IMAGES = [
  ...Object.values(TUTORIAL_TEXT_IMAGES).map(label => label.src),
  'assets/minimap/rust.png?v=1',
  'assets/menu-bg.png?v=3',
  'assets/menu-text/title-untorra.png?v=8',
  'assets/menu-text/item-continue-inactive.png?v=2',
  'assets/menu-text/item-continue-active.png?v=2',
  'assets/menu-text/item-newgame.png?v=2',
  'assets/menu-text/item-settings.png?v=1',
  'assets/menu-text/settings-back.png?v=1',
  'assets/menu-text/settings-volume.png?v=1',
  'assets/menu-text/settings-postprocessing.png?v=1',
  'assets/menu-text/item-credits.png?v=2',
  'assets/menu-text/item-physical-ost.png?v=1',
  'assets/menu-text/item-back.png?v=2',
  'assets/menu-text/credits-matthew-swan.png?v=1',
  'assets/menu-text/credits-matthew-swan-hover.png?v=1',
  'assets/menu-text/credits-comma-2026.png?v=1',
  'assets/menu-text/credits-special-thanks-to.png?v=1',
  'assets/menu-text/credits-riley-w.png?v=1',
  'assets/menu-text/credits-riley-w-hover.png?v=1',
  'assets/menu-text/credits-line3.png?v=1',
  'assets/menu-text/credits-line4.png?v=1',
  'assets/cursors/passive-arrow.png',
  'assets/cursors/front.png',
  'assets/cursors/back.png',
  'assets/cursors/left.png',
  'assets/cursors/right.png',
  'assets/cursors/grab.png',
];
function preloadMenuImages() {
  // Not routed through assetPath() here — that percent-encodes each
  // '/'-delimited segment, which would mangle a trailing "?v=N" query
  // into "%3Fv%3DN". None of these filenames contain characters that
  // actually need encoding, so using the literal path is safe.
  return Promise.all(MENU_UI_IMAGES.map(path => preloadTrack(new Promise(resolve => {
    const im = new Image();
    im.onload = resolve;
    im.onerror = resolve;
    im.src = path;
  }))));
}

const ENDING_DARK_MS = 2000;
function openEndingMenu() {
  muteGameAudio(0); // instant — cancels/overrides whatever fade-out updateAmbience/updateMusic just scheduled at the top of this same render(), so nothing lingers audibly into the dark gap
  setTimeout(() => {
    continueBtn.style.display = 'none';
    titleScreen.classList.remove('hidden');
    playEndingFromStart();
  }, ENDING_DARK_MS);
}

function init() {
  try {
    const saved = localStorage.getItem(MASTER_VOLUME_STORE);
    if (saved !== null) setMasterVolume(saved);
  } catch (error) {}
  // Not registered with preloadTrack() — these ARE the glyphs the percent
  // readout itself is drawn with, so warming them can't be gated on the
  // percent they'd be reporting on.
  Object.values(DIGIT_IMAGES).forEach(src => { new Image().src = src; });

  const ambientReady = initAmbientTracks();
  const musicReady = initMusicTracks();
  const allAssetsReady = preloadAllAssets();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryResumeAudio();
  });
  ['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, tryResumeAudio);
  });

  imgA = document.getElementById('img-a');
  imgB = document.getElementById('img-b');
  activeImg = imgA;
  hotspotLayer = document.getElementById('hotspot-layer');
  tabloLayer = document.getElementById('tablo-layer');
  colliderLayer = document.getElementById('collider-layer');
  fadeOverlay = document.getElementById('fade-overlay');
  sceneWrap = document.getElementById('scene-wrap');
  vignetteEl = document.getElementById('vignette');

  colliderLayer.addEventListener('click', (e) => handleColliderClick(e.clientX, e.clientY));
  colliderLayer.addEventListener('mousemove', (e) => updateColliderCursor(e.clientX, e.clientY));
  colliderLayer.addEventListener('mouseleave', () => { colliderLayer.style.cursor = CURSOR_CSS.passive; });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      repositionOverlays();
      // the low-res buffer is sized off the stage, so it has to be redrawn
      if (minimapOpen) { minimapMeasuredBox = null; scheduleMinimapRefit(); }
    }, 100);
  });

  titleScreen = document.getElementById('title-screen');
  const menuReady = preloadMenuImages();
  // preloadTotal is now fully accumulated (every preload* call above ran
  // synchronously) — safe to draw the starting "0%" (or wherever a couple
  // of instant cache hits already put it) before anything else resolves.
  renderLoadingPercent();
  Promise.all([ambientReady, musicReady, allAssetsReady, menuReady]).then(() => {
    stopLoadingIndicator();
    titleScreen.classList.add('assets-ready');
  });
  creditsScreen = document.getElementById('credits-screen');
  newGameBtn = document.getElementById('menu-newgame');
  continueBtn = document.getElementById('menu-continue');
  continueImg = continueBtn.querySelector('img');
  creditsBtn = document.getElementById('menu-credits');
  creditsBackBtn = document.getElementById('credits-back');
  storeBtn = document.getElementById('menu-store');
  initSettings();
  setMasterVolume(masterVolume * 100);

  CREDITS_LINKS.forEach(({ id, normal, hover }) => {
    const img = document.getElementById(id);
    img.addEventListener('mouseenter', () => { img.src = hover; });
    img.addEventListener('mouseleave', () => { img.src = normal; });
  });

  newGameBtn.addEventListener('click', () => {
    tryResumeAudio();
    // fade to black, hold there, swap the menu for the actual game while
    // still hidden, then fade back in on hub — same fadeOverlay primitive
    // every other scripted transition uses (startAutoAdvance), just
    // triggered by a click instead of firing on node arrival. render()
    // itself removes fadeOverlay's "show" class (via stopAutoAdvance(),
    // which exists to cancel an in-flight auto-advance fade) — that's what
    // actually starts the fade-back-out, so the hold has to happen *before*
    // render() runs, not after, or it gets skipped.
    const FADE_IN_MS = 800;
    const HOLD_MS = 500;
    const FADE_OUT_MS = 3000;
    continueBtn.style.display = ''; // in case this is a restart from the ending menu
    fadeOverlay.style.transitionDuration = FADE_IN_MS + 'ms';
    fadeOverlay.classList.add('show');
    setTimeout(() => {
      setTimeout(() => {
        resetGameState();
        gameStarted = true;
        titleScreen.classList.add('hidden');
        fadeOverlay.style.transitionDuration = FADE_OUT_MS + 'ms';
        render();
      }, HOLD_MS);
    }, FADE_IN_MS);
  });

  continueBtn.addEventListener('click', () => {
    if (!gameStarted) return;
    resumeGame();
  });

  creditsBtn.addEventListener('click', () => {
    titleScreen.classList.add('hidden');
    creditsScreen.classList.remove('hidden');
  });

  creditsBackBtn.addEventListener('click', () => {
    creditsScreen.classList.add('hidden');
    titleScreen.classList.remove('hidden');
  });

  const PHYSICAL_OST_URL = 'https://empyrean-records.myshopify.com/products/emp08-matt-swan-untorra?variant=58441317876056&fbclid=PAVERFWAUP-01wZG9mAmZkaWQWUOJ1nD-ZMF8bUdVJL1m4505smNTyAGV4dG4DYWVtAjEwAHNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABp5m0VqzVoXrEwh6ff7j49Ht8EsjI4x8pQBNlyHNNkAdX3AuaTs4gkC5QjZdr_aem_-3HFpAclP3xkbL9aanGAGw';
  storeBtn.addEventListener('click', () => {
    window.open(PHYSICAL_OST_URL, '_blank', 'noopener,noreferrer');
  });

  initTutorial();
  initMinimapControls();
  loadMinimapDither();

  // Navigation sprites are fetched up front so the first
  // press of the right button is never a frame of empty reticles.
  ['target', 'side', 'star'].forEach(n => { new Image().src = 'assets/nav/' + n + '.png?v=1'; });

  // Right button held = "where can I go from here"; the menu it would
  // normally raise is suppressed over the stage only.
  const stageEl = document.getElementById('stage');
  stageEl.addEventListener('contextmenu', (e) => e.preventDefault());
  stageEl.addEventListener('mousedown', (e) => { if (e.button === 2) showNavMarkers(); });
  window.addEventListener('mouseup', (e) => { if (e.button === 2) hideNavMarkers(); });
  window.addEventListener('blur', hideNavMarkers);

  // e.code, not e.key — on a Cyrillic layout the same physical key types "ь"
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM') return;
    if (minimapOpen) closeMinimap(); else openMinimap();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!settingsScreen.classList.contains('hidden')) { closeSettings(); return; }
    if (!gameStarted) return;
    // map open -> Esc just closes it, without pausing into the menu
    if (minimapOpen) { closeMinimap(); return; }
    if (!creditsScreen.classList.contains('hidden')) return; // ignore while in credits
    if (titleScreen.classList.contains('hidden')) {
      // currently in-game -> Esc pauses into the menu
      continueBtn.style.display = '';
      continueBtn.classList.add('active');
      continueImg.src = 'assets/menu-text/item-continue-active.png?v=2';
      titleScreen.classList.remove('hidden');
      muteGameAudio();
    } else {
      // menu already open -> Esc acts exactly like clicking continue
      resumeGame();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
