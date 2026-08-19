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
function playOneShot(file, vol) {
  const audio = new Audio(sound(file));
  const boost = /^note [1-4]\.ogg$/.test(file) ? NOTE_BOOST : 1;
  audio.volume = (vol ?? 1) * ONESHOT_VOL * boost;
  audio.play().catch(() => {});
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
  towerSolved: false
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
  ending: 'final ending.ogg'
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
const ambientTracks = {};

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

function initAmbientTracks() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  for (const key in AMBIENT_FILES) {
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioCtx.destination);
    const t = { gainNode, source: null };
    ambientTracks[key] = t;
    fetch(sound(AMBIENT_FILES[key]))
      .then(r => r.arrayBuffer())
      .then(buf => audioCtx.decodeAudioData(buf))
      .then(audioBuffer => {
        smoothLoopEdges(audioBuffer, Math.round(audioCtx.sampleRate * 0.015));
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.loop = true;
        src.connect(gainNode);
        src.start(0);
        t.source = src;
      })
      .catch(err => console.warn('ambient track failed to load:', key, err));
  }
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

function updateAmbience(nodeId) {
  setAmbient('cave', CAVE_NODES.has(nodeId) ? AMBIENT_MASTER_VOL : 0, AMBIENT_FADE_MS);
  setAmbient('seaWind', SEA_WIND_NODES.has(nodeId) ? AMBIENT_MASTER_VOL : 0, AMBIENT_FADE_MS);
  setAmbient('seaWaves', SEA_WAVES_FULL.has(nodeId) ? AMBIENT_MASTER_VOL : SEA_WAVES_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, AMBIENT_FADE_MS);
  setAmbient('buzz', BUZZ_FULL.has(nodeId) ? AMBIENT_MASTER_VOL : BUZZ_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, AMBIENT_FADE_MS);
  setAmbient('greenhouseWind', (GREENHOUSE_WIND_FULL.has(nodeId) || TOWER_NODES.has(nodeId)) ? AMBIENT_MASTER_VOL : GREENHOUSE_WIND_QUIET.has(nodeId) ? AMBIENT_QUIET_VOL : 0, AMBIENT_FADE_MS);

  // Grows louder frame by frame through the ending sequence (final_1..12),
  // peaking at full volume right as final_12 is reached; silent everywhere
  // else, including the true black ending screen (final_13).
  const finalMatch = /^final_(\d+)$/.exec(nodeId);
  const finalN = finalMatch ? parseInt(finalMatch[1], 10) : null;
  const finalNoiseTarget = (finalN >= 1 && finalN <= 12) ? (finalN / 12) * AMBIENT_MASTER_VOL * FINAL_NOISE_BOOST : 0;
  setAmbient('finalNoise', finalNoiseTarget, AMBIENT_FADE_MS);
}

const musicTracks = {};

function initMusicTracks() {
  for (const key in MUSIC_FILES) {
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioCtx.destination);
    const t = { gainNode, source: null };
    musicTracks[key] = t;
    fetch(musicSound(MUSIC_FILES[key]))
      .then(r => r.arrayBuffer())
      .then(buf => audioCtx.decodeAudioData(buf))
      .then(audioBuffer => {
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.loop = true;
        src.connect(gainNode);
        src.start(0);
        t.source = src;
      })
      .catch(err => console.warn('music track failed to load:', key, err));
  }
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

function updateMusic(nodeId) {
  setMusic('jazz', MUSIC_JAZZ_NODES.has(nodeId) ? MUSIC_JAZZ_VOL : 0, MUSIC_JAZZ_NODES.has(nodeId) ? MUSIC_FADE_IN_MS : MUSIC_FADE_OUT_MS);
  setMusic('barbershop', MUSIC_BARBERSHOP_NODES.has(nodeId) ? MUSIC_BARBERSHOP_VOL : 0, MUSIC_BARBERSHOP_NODES.has(nodeId) ? MUSIC_FADE_IN_MS : MUSIC_FADE_OUT_MS);
  setMusic('greenhouse', MUSIC_GREENHOUSE_NODES.has(nodeId) ? 1 : 0, MUSIC_GREENHOUSE_NODES.has(nodeId) ? MUSIC_FADE_IN_MS : MUSIC_FADE_OUT_MS);
  setMusic('industrial', MUSIC_INDUSTRIAL_NODES.has(nodeId) ? 1 : 0, MUSIC_INDUSTRIAL_NODES.has(nodeId) ? MUSIC_FADE_IN_MS : MUSIC_FADE_OUT_MS);
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
  "tunnel1_a_back": { map: "assets/colliders/tunnel1_a_back.png", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel1_a_front", "cursor": "back"}] },
  "tunnel1_b_front": { map: "assets/colliders/tunnel1_b_front.png", actions: [null, {"to": "beach_a_front", "cursor": "front"}, {"to": "tunnel1_b_back", "cursor": "back"}] },
  "tunnel1_b_back": { map: "assets/colliders/tunnel1_b_back.png", actions: [null, {"to": "tunnel1_a_back", "cursor": "front"}, {"to": "tunnel1_b_front", "cursor": "back"}] },
  "tunnel1_a_front": { map: "assets/colliders/tunnel1_a_front.png", actions: [null, {"to": "tunnel1_a_back", "cursor": "left"}, {"to": "tunnel1_b_front", "cursor": "front"}] },
  "beach_a_front": { map: "assets/colliders/beach_a_front.png", actions: [null, {"to": "beach_b_front", "cursor": "front"}, {"to": "beach_a_back", "cursor": "back"}] },
  "beach_a_back": { map: "assets/colliders/beach_a_back.png", actions: [null, {"to": "tunnel1_b_back", "cursor": "front"}, {"to": "beach_a_front", "cursor": "back"}] },
  "beach_b_front": { map: "assets/colliders/beach_b_front.png", actions: [null, {"to": "beach_b_left", "cursor": "left"}, {"to": "beach_b_right", "cursor": "right"}, {"to": "ezh_inside", "cursor": "front"}] },
  "beach_b_back": { map: "assets/colliders/beach_b_back.png", actions: [null, {"to": "beach_a_back", "cursor": "front"}, {"to": "beach_b_right", "cursor": "left"}, {"to": "beach_b_left", "cursor": "right"}] },
  "beach_b_left": { map: "assets/colliders/beach_b_left.png", actions: [null, {"to": "beach_b_back", "cursor": "left"}, {"to": "beach_b_front", "cursor": "right"}, {"to": "storgage_view", "cursor": "front"}] },
  "beach_b_right": { map: "assets/colliders/beach_b_right.png", actions: [null, {"to": "beach_b_front", "cursor": "left"}, {"to": "beach_b_back", "cursor": "right"}] },
  "ezh_inside": { map: "assets/colliders/ezh_inside.png", actions: [null, {"to": "ezh_inside2", "cursor": "front"}, {"to": "beach_b_front", "cursor": "back"}] },
  "ezh_inside2": { map: "assets/colliders/ezh_inside2.png", actions: [null, {"to": "ezh_mayak", "cursor": "front"}, {"to": "ezh_inside", "cursor": "left"}, {"to": "ezh_sea", "cursor": "right"}] },
  "ezh_mayak": { map: "assets/colliders/ezh_mayak.png", actions: [null, {"to": "ezh_sea", "cursor": "front"}, {"to": "ezh_inside2", "cursor": "back"}] },
  "ezh_sea": { map: "assets/colliders/ezh_sea.png", actions: [null, {"to": "ezh_inside2", "cursor": "back"}] },
  "storgage_view": { map: "assets/colliders/storgage_view.png", actions: [null, {"to": "beach_b_left", "cursor": "back"}] },
  "hub": { map: "assets/colliders/hub.png", actions: [null, {"to": "first_portal", "cursor": "left"}, {"to": "third_gate", "cursor": "right"}, {"to": "second_door", "cursor": "front"}, {"to": "lever_view", "cursor": "front"}] },
  "lever_view": { map: "assets/colliders/lever_view.png", actions: [null, {"to": "second_door", "cursor": "left"}, {"to": "third_gate", "cursor": "right"}, {"action": "toggleLever", "cursor": "grab"}] },
  "second_door": { map: "assets/colliders/second_door.png", actions: [null, {"to": "tunnel2_1_1", "cursor": "front"}, {"to": "first_portal", "cursor": "left"}, {"to": "lever_view", "cursor": "right"}] },
  "first_portal": { map: "assets/colliders/first_portal.png", actions: [null, {"to": "hub", "cursor": "left"}, {"to": "tunnel1_a_front", "cursor": "front"}, {"to": "second_door", "cursor": "right"}] },
  "third_gate__closed": { map: "assets/colliders/third_gate__closed.png", actions: [null, {"to": "hub", "cursor": "back"}, {"action": "toggleLever", "cursor": "grab"}, {"sound": "door hit.ogg", "cursor": "grab"}] },
  "third_gate__open": { map: "assets/colliders/third_gate__open.png", actions: [null, {"to": "hub", "cursor": "back"}, {"to": "tunnel3_1_1", "cursor": "front"}, {"action": "toggleLever", "cursor": "grab"}] },
  "tunnel2_1_1": { map: "assets/colliders/tunnel2_1_1.png", actions: [null, {"to": "tunnel2_2_1", "cursor": "front"}, {"to": "tunnel2_1_2", "cursor": "back"}] },
  "tunnel2_1_2": { map: "assets/colliders/tunnel2_1_2.png", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel2_1_1", "cursor": "back"}] },
  "tunnel2_2_1": { map: "assets/colliders/tunnel2_2_1.png", actions: [null, {"to": "room2_1_1", "cursor": "front"}, {"to": "tunnel2_2_2", "cursor": "back"}] },
  "tunnel2_2_2": { map: "assets/colliders/tunnel2_2_2.png", actions: [null, {"to": "tunnel2_1_2", "cursor": "front"}, {"to": "tunnel2_2_1", "cursor": "back"}] },
  "room2_1_2": { map: "assets/colliders/room2_1_2.png", actions: [null, {"to": "tunnel2_2_2", "cursor": "front"}, {"to": "room2_1_1", "cursor": "back"}] },
  "room2_1_1": { map: "assets/colliders/room2_1_1.png", actions: [null, {"to": "room2_1_3", "cursor": "left"}, {"to": "room2_1_2", "cursor": "right"}, {"to": "room2_2_1", "cursor": "front"}, {"to": "cables_1", "cursor": "front"}, {"to": "room2_1_5", "cursor": "front"}, {"to": "room2_1_2", "cursor": "back"}] },
  "room2_1_3": { map: "assets/colliders/room2_1_3.png", actions: [null, {"to": "room2_1_1", "cursor": "back"}] },
  "room2_1_5": { map: "assets/colliders/room2_1_5.png", actions: [null, {"to": "room2_1_1", "cursor": "back"}, {"to": "room2_2_1", "cursor": "front"}, {"to": "cables_1", "cursor": "front"}] },
  "room2_2_1": { map: "assets/colliders/room2_2_1.png", actions: [null, {"to": "lift_1_1", "cursor": "front"}, {"to": "room2_1_1", "cursor": "back"}] },
  "cables_1": { map: "assets/colliders/cables_1.png", actions: [null, {"to": "room2_1_1", "cursor": "back"}, {"to": "cables_2a", "cursor": "front"}, {"to": "room2_2_1", "cursor": "front"}] },
  "cables_2a": { map: "assets/colliders/cables_2a.png", actions: [null, {"to": "cables_3", "cursor": "front"}, {"to": "cables_2b", "cursor": "back"}] },
  "cables_2b": { map: "assets/colliders/cables_2b.png", actions: [null, {"to": "room2_1_2", "cursor": "front"}, {"to": "cables_2a", "cursor": "back"}, {"to": "cables_2a", "cursor": "front"}] },
  "cables_3": { map: "assets/colliders/cables_3.png", actions: [null, {"to": "cables_2b", "cursor": "back"}] },
  "lift_1_1": { map: "assets/colliders/lift_1_1.png", actions: [null, {"to": "lift_1_2", "cursor": "left"}, {"to": "lift_2_1", "cursor": "front"}] },
  "lift_1_2": { map: "assets/colliders/lift_1_2.png", actions: [null, {"to": "room2_1_2", "cursor": "front"}, {"to": "lift_1_1", "cursor": "back"}] },
  "lift_2_2": { map: "assets/colliders/lift_2_2.png", actions: [null, {"to": "lift_1_2", "cursor": "front"}, {"to": "lift_2_1", "cursor": "back"}] },
  "lift_2_1__green": { map: "assets/colliders/lift_2_1__green.png", actions: [null, {"to": "lift_2_2", "cursor": "back"}, {"to": "lift_3_1", "cursor": "front"}, {"to": "lift_panel", "cursor": "front"}] },
  "lift_2_1__red": { map: "assets/colliders/lift_2_1__red.png?v=2", actions: [null, {"to": "lift_2_2", "cursor": "back"}, {"sound": "door hit.ogg", "cursor": "grab"}, {"to": "lift_panel", "cursor": "front"}] },
  "lift_panel": { map: "assets/colliders/lift_panel.png", actions: [null, {"to": "lift_2_1", "cursor": "back"}] },
  "greenhouse_1_1": { map: "assets/colliders/greenhouse_1_1.png", actions: [null, {"to": "greenhouse_2_1", "cursor": "front"}, {"to": "lift_3_1", "cursor": "back"}] },
  "lift_3_1__fromGreenhouse": { map: "assets/colliders/greenhouse_1_1.png", actions: [null, {"to": "lift_2_2", "cursor": "front"}, {"to": "greenhouse_1_1", "cursor": "back"}] },
  "greenhouse_2_1": { map: "assets/colliders/greenhouse_2_1.png", actions: [null, {"to": "greenhouse_3_1", "cursor": "front"}, {"to": "greenhouse_2_2", "cursor": "back"}] },
  "greenhouse_2_2": { map: "assets/colliders/greenhouse_2_2.png", actions: [null, {"to": "greenhouse_1_1", "cursor": "front"}, {"to": "greenhouse_2_1", "cursor": "back"}] },
  "greenhouse_3_1": { map: "assets/colliders/greenhouse_3_1.png", actions: [null, {"to": "greenhouse_3_2", "cursor": "back"}, {"to": "greenhouse_4_1", "cursor": "front"}, {"to": "greenhouse_3_4", "cursor": "front"}] },
  "greenhouse_3_2": { map: "assets/colliders/greenhouse_3_2.png", actions: [null, {"to": "greenhouse_2_2", "cursor": "front"}, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "greenhouse_3_4": { map: "assets/colliders/greenhouse_3_4.png", actions: [null, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "greenhouse_4_1": { map: "assets/colliders/greenhouse_4_1.png", actions: [null, {"to": "greenhouse_3_1", "cursor": "back"}] },
  "tunnel3_1_1": { map: "assets/colliders/tunnel3_1_1.png", actions: [null, {"to": "tunnel3_1_2", "cursor": "left"}, {"to": "tunnel3_2_1", "cursor": "front"}] },
  "tunnel3_1_2": { map: "assets/colliders/tunnel3_1_2.png", actions: [null, {"to": "hub", "cursor": "front"}, {"to": "tunnel3_1_1", "cursor": "back"}] },
  "tunnel3_2_1": { map: "assets/colliders/tunnel3_2_1.png", actions: [null, {"to": "tower_1_1", "cursor": "front"}, {"to": "tunnel3_2_2", "cursor": "back"}] },
  "tunnel3_2_2": { map: "assets/colliders/tunnel3_2_2.png", actions: [null, {"to": "tunnel3_1_2", "cursor": "front"}, {"to": "tunnel3_2_1", "cursor": "back"}] },
  "tower_1_1": { map: "assets/colliders/tower_1_1.png", actions: [null, {"to": "tower_1_2", "cursor": "left"}, {"to": "tower_1_4", "cursor": "right"}, {"to": "tower_2_1", "cursor": "front"}] },
  "tower_1_2": { map: "assets/colliders/tower_1_2.png?v=2", actions: [null, {"to": "tunnel3_2_2", "cursor": "front"}, {"to": "tower_1_1", "cursor": "back"}, {"to": "tower_1_4", "cursor": "left"}] },
  "tower_1_4": { map: "assets/colliders/tower_1_4.png?v=2", actions: [null, {"to": "towerlift_1_1", "cursor": "front"}, {"to": "tower_1_1", "cursor": "back"}, {"to": "tower_1_2", "cursor": "right"}] },
  "tower_2_1": { map: "assets/colliders/tower_2_1.png", actions: [null, {"to": "tower_3_1", "cursor": "front"}, {"to": "tower_2_2", "cursor": "back"}] },
  "tower_2_2": { map: "assets/colliders/tower_2_2.png", actions: [null, {"to": "tower_1_2", "cursor": "front"}, {"to": "tower_2_1", "cursor": "back"}] },
  "tower_3_1": { map: "assets/colliders/tower_3_1.png", actions: [null, {"to": "tower_4_1", "cursor": "front"}, {"to": "tower_2_2", "cursor": "back"}] },
  "tower_4_1": { map: "assets/colliders/tower_4_1.png", actions: [null, {"to": "tower_3_1", "cursor": "back"}] },
  "towerlift_1_1": { map: "assets/colliders/towerlift_1_1.png", actions: [null, {"to": "towerlift_2_1", "cursor": "front"}, {"to": "towerlift_1_2", "cursor": "back"}] },
  "towerlift_1_2": { map: "assets/colliders/towerlift_1_2.png", actions: [null, {"to": "tower_1_1", "cursor": "front"}, {"to": "tower_1_2", "cursor": "left"}, {"to": "tower_1_1", "cursor": "right"}] },
  "towerlift_2_1": { map: "assets/colliders/towerlift_2_1.png", actions: [null, {"to": "towerlift_1_1", "cursor": "back"}, {"action": "towerliftInteract", "flavor": "Здесь тихо и пусто.", "sound": "button press.ogg", "cursor": "grab"}] },

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

function ensureColliderLoaded(path) {
  if (colliderImageCache[path]) return;
  colliderImageCache[path] = 'loading';
  const im = new Image();
  im.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = im.naturalWidth;
    canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(im, 0, 0);
    colliderImageCache[path] = ctx.getImageData(0, 0, canvas.width, canvas.height);
  };
  im.src = path;
}

// Shared by click and hover — returns the action at a client-space point, or
// null if there's no collider for the current node / the point misses / the
// map hasn't finished loading yet.
function resolveColliderAction(clientX, clientY) {
  const key = colliderKeyFor(state.current);
  const cfg = COLLIDER_DATA[key];
  if (!cfg) return null;
  const data = colliderImageCache[cfg.map];
  if (!data || data === 'loading') return null;

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
  front: `url("assets/cursors/front.png") 11 0, pointer`,
  back:  `url("assets/cursors/back.png") 9 0, pointer`,
  left:  `url("assets/cursors/left.png") 0 11, pointer`,
  right: `url("assets/cursors/right.png") 24 11, pointer`,
  grab:  `url("assets/cursors/grab.png") 11 11, pointer`,
};
const ICON_CURSOR = { '↑': 'front', '↻': 'back', '←': 'left', '→': 'right', '✋': 'grab' };

function updateColliderCursor(clientX, clientY) {
  const action = resolveColliderAction(clientX, clientY);
  // unclassified/no-op ground (or a node with no collider map at all, e.g.
  // lift_3_1 mid-auto-advance) still shows the front cursor rather than
  // reverting to the plain OS pointer — every pixel over the scene reads
  // as "clickable" even where nothing's actually wired up yet.
  colliderLayer.style.cursor = CURSOR_CSS[(action && action.cursor) || 'front'];
}

function mkFinal(n) {
  return {
    title: 'Финал',
    image: () => img(`4 final/${n}.jpg`),
    hotspots: [],
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
    noVignette: true
  },
  // pure black — the actual end of the game, reached only by clicking
  // through final_12; no collider entry at all, so nothing happens on
  // click here (a real dead end, not just an unconfirmed one)
  final_13: {
    title: 'Финал',
    image: () => img('4 final/13.jpg'),
    hotspots: [],
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
let hotspotLayer, tabloLayer, colliderLayer, fadeOverlay, sceneWrap, vignetteEl;
let titleScreen, creditsScreen, newGameBtn, continueBtn, continueImg, creditsBtn, creditsBackBtn, storeBtn;
// true once "new game" has actually been pressed once — gates both the
// "continue" menu item and whether Esc is allowed to pause into the menu
// (nothing to pause into before a game exists)
let gameStarted = false;

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
function stopAutoAdvance() {
  autoAdvanceTimers.forEach(clearTimeout);
  autoAdvanceTimers = [];
  fadeOverlay.classList.remove('show');
}

// Holds the current frame, fades to black, jumps to `to`, then fades back in.
// Cancelled by stopAutoAdvance() if the player navigates away mid-hold.
function startAutoAdvance({ holdMs, fadeMs, to, sound: soundFile }) {
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
    playOneShot(sounds[i], volume);

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
  vignetteEl.style.display = node.noVignette ? 'none' : '';

  const nextImg = activeImg === imgA ? imgB : imgA;
  nextImg.src = resolve(node.image);
  nextImg.onload = () => {
    imgA.classList.toggle('active', nextImg === imgA);
    imgB.classList.toggle('active', nextImg === imgB);
    activeImg = nextImg;
  };

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

  if (node.openEndingMenu) openEndingMenu();
}

function navigate(id) {
  if (!nodes[id]) return;
  state.history.push(state.current);
  state.prevNode = state.current;
  state.current = id;
  render();
}

// "new game" from the Esc menu must actually start over, not just resume
// where "continue" would — restores every mutable field back to its initial
// value (mirrors the literal shape of the `state` object above).
function resetGameState() {
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
  for (const key in ambientTracks) setAmbient(key, 0, fadeMs);
  for (const key in musicTracks) setMusic(key, 0, fadeMs);
}
function unmuteGameAudio() {
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
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
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

  for (const key in COLLIDER_DATA) {
    const cfg = COLLIDER_DATA[key];
    ensureColliderLoaded(cfg.map);
    cfg.actions.forEach(a => { if (a && a.sound) soundFiles.add(a.sound); });
  }

  imageUrls.forEach(url => { new Image().src = url; });
  soundFiles.forEach(file => { fetch(sound(file)).catch(() => {}); });
}

// Menu chrome (background, logo, button labels, cursors) is small but each
// piece still paints independently the moment its own request finishes —
// on a first visit that reads as the menu assembling itself piece by piece
// rather than appearing at once. #title-screen starts at opacity:0 (see
// style.css) and only gets revealed once every one of these has actually
// finished loading (or failed — a broken image shouldn't hold the menu
// hostage forever).
const MENU_UI_IMAGES = [
  'assets/menu-bg.png',
  'assets/menu-text/title-untorra.png',
  'assets/menu-text/item-continue-inactive.png',
  'assets/menu-text/item-continue-active.png',
  'assets/menu-text/item-newgame.png',
  'assets/menu-text/item-credits.png',
  'assets/menu-text/item-physical-ost.png',
  'assets/menu-text/item-back.png',
  'assets/menu-text/credits-body.png',
  'assets/cursors/front.png',
  'assets/cursors/back.png',
  'assets/cursors/left.png',
  'assets/cursors/right.png',
  'assets/cursors/grab.png',
];
function preloadMenuImages() {
  return Promise.all(MENU_UI_IMAGES.map(path => new Promise(resolve => {
    const im = new Image();
    im.onload = resolve;
    im.onerror = resolve;
    im.src = assetPath(path);
  })));
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
  initAmbientTracks();
  initMusicTracks();
  preloadAllAssets();

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
  colliderLayer.addEventListener('mouseleave', () => { colliderLayer.style.cursor = 'auto'; });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(repositionOverlays, 100);
  });

  titleScreen = document.getElementById('title-screen');
  preloadMenuImages().then(() => titleScreen.classList.add('assets-ready'));
  creditsScreen = document.getElementById('credits-screen');
  newGameBtn = document.getElementById('menu-newgame');
  continueBtn = document.getElementById('menu-continue');
  continueImg = continueBtn.querySelector('img');
  creditsBtn = document.getElementById('menu-credits');
  creditsBackBtn = document.getElementById('credits-back');
  storeBtn = document.getElementById('menu-store');

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

  // TODO: no physical-OST store URL yet — wire this once there's a real one
  // (e.g. storeBtn.addEventListener('click', () => window.open(URL, '_blank')))
  storeBtn.addEventListener('click', () => {});

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !gameStarted) return;
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
