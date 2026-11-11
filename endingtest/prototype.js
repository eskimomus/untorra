import { SCENES, GOD_PROFILES, VISITOR_PLANS, NAME_MAX_LENGTH, limitNameInput, sceneById, cleanName, transitionFor, createRun, advanceRun, previewScene, decisionSnapshot, isTripScene, isSeamlessTransition, SceneClock } from './story.js?v=16';
import { EndingRepository } from './online.js?v=3';
import { ONLINE_API_BASE } from './online-config.js?v=1';
import { PsychedelicRenderer, EndingAudio } from './psychedelic.js?v=18';
import { Sequence, TypingAudio, typingTokens, syncAnimations, syncSceneAnimations, echoRevealGroups, echoJitterFrames } from './text-presentation.js?v=16';
import { VideoCaption } from './video-presentation.js?v=4';
import { alienInkColor, alienWords, concurrentTypingFrames, echoTranslationFrames, loadAlienGlyphAtlas } from './alien-text.js?v=10';
import { getTextSettings, mountTextSettings } from './text-settings.js?v=3';

const sceneHost = document.getElementById('scene');
const game = document.getElementById('game');
const stage = document.getElementById('stage');
const tripVideo = document.getElementById('trip-video');
const repeatTripVideo = document.getElementById('repeat-trip-video');
const killVideo = document.getElementById('kill-video');
const afterKillVideo = document.getElementById('after-kill-video');
const godDeathVideo = document.getElementById('god-death-video');
const sceneVideos = new Map([['3a', killVideo], ['3a-after', afterKillVideo], ['3c', killVideo], ['7a', tripVideo], ['13a', godDeathVideo], ['14d', killVideo], ['15d', repeatTripVideo], ['15e', repeatTripVideo]]);
const videos = Array.from(new Set(sceneVideos.values()));
const fadeOverlay = document.getElementById('fade-overlay');
const startButton = document.getElementById('start-ending');
const tools = document.getElementById('prototype-tools');
const picker = document.getElementById('scene-picker');
const status = document.getElementById('prototype-status');
const pauseInput = document.getElementById('pause-story');
const reducedInput = document.getElementById('reduced-motion');
const godInput = document.getElementById('god-profile');
const visitorsInput = document.getElementById('visitor-plan');
const skipButton = document.getElementById('next-scene');
const exportButton = document.getElementById('export-decisions');
const preferences = matchMedia('(prefers-reduced-motion: reduce)');
const audio = new EndingAudio();
const typingAudio = new TypingAudio();
const presentation = new Sequence();
const echoPresentations = new Set();
const transition = new Sequence();
const textModels = new WeakMap();
const firstTripCaption = new VideoCaption();
const godDeathCaption = new VideoCaption({ firstFrame: 60, lastFrame: 119 });
const FADE_MS = 400;
const query = new URLSearchParams(location.search);
const embedded = query.get('embedded') === '1' && window.parent !== window;
let hostPaused = embedded, hostRequestedPause = true, hostStarted = false, hostStarting = false, outputVolume = 1;
let completionReported = false;
let state = createRun();
if (embedded) {
  state = createRun({ godId: Math.random() < 0.5 ? 'merciful' : 'cruel' });
  document.body.classList.add('embedded');
  presentation.pause('host');
}
state.reduced = preferences.matches;
const clock = new SceneClock(() => act('auto'));
if (embedded) clock.pause('host');
let renderer;
let layout;
let nameEntryResize = null;
let nativeScale = 1;
let ready = false;
let videoScene = null;
let sceneVideo = null;
let videoSoundUnlocked = false;
let transitioning = false;
let waitingForGesture = false;
let starting = false;
let screenShake = null;
let postKillImage;
let alienAtlas;
let stillHandoff = 0;
const repository = new EndingRepository({ baseUrl: ONLINE_API_BASE });

function notifyHost(type, detail = {}) {
  if (embedded) window.parent.postMessage({ source: 'untorra-ending', type, ...detail }, location.origin);
}

async function applyHostSettings(settings) {
  hostRequestedPause = !!settings.paused;
  if (!hostStarted) {
    const profile = GOD_PROFILES.find(profile => profile.id === settings.godId);
    const plan = VISITOR_PLANS.find(plan => plan.id === settings.visitorPlanId);
    if (profile) { state.god = profile; godInput.value = profile.id; }
    if (plan) { state.plan = plan; visitorsInput.value = plan.id; }
  }
  if (Number.isFinite(settings.volume)) {
    outputVolume = Math.max(0, Math.min(1, settings.volume));
    audio.volume = outputVolume;
    typingAudio.setVolume(outputVolume);
    for (const video of videos) video.volume = outputVolume;
    audio.update();
  }
  if (ready && settings.start && !hostStarted && !hostStarting) {
    hostStarting = true;
    await unlockSound();
    hostStarted = true;
    hostStarting = false;
  }
  hostPaused = !hostStarted || hostRequestedPause;
  if (ready) syncSuspension();
}

if (embedded) window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin || event.data?.source !== 'untorra-game' || event.data.type !== 'settings') return;
  applyHostSettings(event.data);
});

const assets = [
  'assets/figma/3a-imgUntorraBooklet3Copy21.png',
  'assets/figma/9a-imgUntorraBooklet3Copy21.svg',
  'assets/figma/9a-imgUntorraBooklet3Copy22.png',
  'assets/figma/12a-imgUntorraBooklet3Copy21.png',
  'assets/video/after-kill-final-frame.png',
];

function copy(text, left, top, { size = 16, color = '#fff', width, center = false, html = false, appearance = 'main', voice = 'player', atomicWords = [], translate = true } = {}) {
  const paragraph = document.createElement('p');
  paragraph.className = `copy${size === 24 ? ' thought' : ''}${center ? ' center-copy' : ''}`;
  paragraph.style.left = `${left}px`;
  paragraph.style.top = `${top}px`;
  paragraph.style.fontSize = `${size}px`;
  paragraph.style.color = color;
  if (width) paragraph.style.width = `${width}px`;
  if (html) paragraph.innerHTML = text; else paragraph.textContent = text;
  paragraph.dataset.pixel = '';
  paragraph.dataset.appearance = appearance;
  paragraph.dataset.voice = voice;
  paragraph.dataset.atomicWords = JSON.stringify(atomicWords);
  paragraph.dataset.translation = translate ? 'alien' : 'human';
  layout.appendChild(paragraph);
  return paragraph;
}

function pixelize(paragraph) {
  const textSettings = getTextSettings();
  const text = paragraph.textContent;
  const computed = getComputedStyle(paragraph);
  const control = paragraph.closest('.scene-button');
  if (control) control.style.setProperty('--control-ink', alienInkColor(computed.color, textSettings));
  const size = parseFloat(computed.fontSize);
  const spacing = size * 0.4;
  const measurement = document.createElement('canvas').getContext('2d');
  measurement.font = `${size}px Quantico`;
  const measure = word => Array.from(word).reduce((sum, character) => sum + measurement.measureText(character).width + spacing, -spacing);
  const available = parseFloat(paragraph.style.width) || measure(text) + 1;
  const lines = [];
  let current = '';
  for (const paragraphText of text.split('\n')) {
    if (paragraph.dataset.singleLine === 'true') { lines.push(paragraphText); continue; }
    current = '';
    for (const word of paragraphText.split(' ')) {
      const candidate = current ? current + ' ' + word : word;
      if (current && measure(candidate) > available + 1) { lines.push(current); current = word; }
      else current = candidate;
    }
    lines.push(current);
  }
  const height = size * 1.324 * lines.length;
  const shrink = 0.82;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(available * shrink);
  canvas.height = Math.ceil(height * shrink);
  canvas.style.width = `${available}px`;
  canvas.style.height = `${height}px`;
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  context.scale(canvas.width / available, canvas.height / height);
  context.font = `${size}px Quantico`;
  context.fillStyle = computed.color;
  context.textBaseline = 'alphabetic';
  const segments = Array.from(paragraph.childNodes).map(node => ({ text: node.textContent, color: node.nodeType === Node.ELEMENT_NODE ? getComputedStyle(node).color : computed.color }));
  const glyphs = [];
  let sourceIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let horizontal = paragraph.classList.contains('center-copy') ? (available - measure(line)) / 2 : 0;
    for (const character of Array.from(line)) {
      let offset = sourceIndex;
      const segment = segments.find(part => { if (offset < part.text.length) return true; offset -= part.text.length; return false; });
      const measured = measurement.measureText(character);
      const ink = {
        left: -(measured.actualBoundingBoxLeft ?? 0),
        width: (measured.actualBoundingBoxLeft ?? 0) + (measured.actualBoundingBoxRight ?? measured.width),
        ascent: measured.actualBoundingBoxAscent ?? size * 0.75,
        descent: measured.actualBoundingBoxDescent ?? 0,
      };
      glyphs.push({ character, horizontal, advance: measured.width, ink, vertical: lineIndex * size * 1.324 + size * 0.99, color: segment?.color || computed.color, end: sourceIndex + character.length });
      horizontal += measured.width + spacing;
      sourceIndex += character.length;
    }
    sourceIndex += 1;
  }
  paragraph.setAttribute('aria-label', text);
  paragraph.replaceChildren(canvas);
  const words = alienWords(text, glyphs, size);
  const characters = glyphs.filter(glyph => /\S/u.test(glyph.character));
  const model = { text, visible: text.length, offsetX: 0, draw: null };
  const drawGlyph = glyph => {
    context.fillStyle = alienInkColor(glyph.color, textSettings);
    context.fillText(glyph.character, glyph.horizontal + model.offsetX, glyph.vertical);
  };
  const draw = (visible = model.visible) => {
    model.visible = visible;
    context.clearRect(0, 0, available, height);
    for (const glyph of glyphs) {
      if (glyph.end > visible) continue;
      drawGlyph(glyph);
    }
    paragraph.dataset.language = 'english';
    paragraph.dataset.translatedWords = String(words.length);
    if (paragraph.dataset.visibleCharacters !== String(visible)) paragraph.dataset.visibleCharacters = String(visible);
  };
  model.draw = draw;
  model.drawAlien = (visible = model.visible, translated = 0, revision = 0) => {
    if (!alienAtlas || translated >= words.length) { draw(visible); return; }
    model.visible = visible;
    context.clearRect(0, 0, available, height);
    for (const [index, word] of words.entries()) {
      if (index < translated) {
        for (const glyph of word.glyphs) if (glyph.end <= visible) drawGlyph(glyph);
      } else {
        alienAtlas.drawWord(context, text, word, { visible, revision: index === translated ? revision : 0, offsetX: model.offsetX, settings: textSettings });
      }
    }
    paragraph.dataset.language = translated || revision ? 'translating' : 'alien';
    paragraph.dataset.translatedWords = String(translated);
    paragraph.dataset.visibleCharacters = String(visible);
  };
  model.drawDecoded = (visible, decoded = [], flickering = null, revision = 0) => {
    const resolved = new Set(decoded);
    model.visible = visible;
    paragraph.dataset.decodedCharacters = String(resolved.size);
    paragraph.dataset.decodedGlyphs = JSON.stringify(decoded);
    if (!alienAtlas || resolved.size >= characters.length) { draw(visible); return; }
    context.clearRect(0, 0, available, height);
    for (const word of words) alienAtlas.drawWord(context, text, word, {
      visible, decoded: resolved, flickering, revision, offsetX: model.offsetX, settings: textSettings,
    });
    for (const glyph of characters) if (glyph.end <= visible && resolved.has(glyph.end)) drawGlyph(glyph);
    paragraph.dataset.language = resolved.size || revision ? 'translating' : 'alien';
    paragraph.dataset.translatedWords = String(words.filter(word => word.glyphs.every(glyph => resolved.has(glyph.end))).length);
    paragraph.dataset.visibleCharacters = String(visible);
  };
  model.drawEcho = (decoded = [], flickering = null, revision = 0) => model.drawDecoded(text.length, decoded, flickering, revision);
  textModels.set(paragraph, model);
  draw(text.length);
}

function stopScreenShake(shake = screenShake) {
  if (!shake || screenShake !== shake) return;
  cancelAnimationFrame(shake.frame);
  screenShake = null;
  game.style.setProperty('--screen-shake-x', '0px');
  game.style.setProperty('--screen-shake-y', '0px');
  game.dataset.shaking = 'false';
}

function playTextImpact(sound, strength, maximumDuration = Infinity) {
  let shake;
  const voice = typingAudio.play(sound, { onEnded: () => { if (shake) stopScreenShake(shake); } });
  if (state.reduced) return;
  stopScreenShake();
  const duration = Math.min(maximumDuration, voice?.duration || typingAudio.duration(sound) || 0.5);
  shake = { frame: null, deadline: performance.now() + duration * 1000 };
  screenShake = shake;
  game.dataset.shaking = 'true';
  game.dataset.shakeDuration = String(duration);
  game.dataset.shakeStrength = String(strength);
  game.dataset.shakeSound = sound;
  const update = () => {
    if (screenShake !== shake) return;
    if (performance.now() >= shake.deadline) { stopScreenShake(shake); return; }
    game.style.setProperty('--screen-shake-x', `${Math.round((Math.random() - 0.5) * 2 * strength * nativeScale)}px`);
    game.style.setProperty('--screen-shake-y', `${Math.round((Math.random() - 0.5) * 2 * strength * nativeScale)}px`);
    shake.frame = requestAnimationFrame(update);
  };
  update();
}

function playTypingToken(token) {
  if (token.letterSound) playTextImpact(token.letterSound, 1, 0.12);
  if (token.sound === 'untorra') playTextImpact('untorra', 3);
  else if (token.sound) typingAudio.play(token.sound);
}

function postKillStill(target = layout) {
  const image = document.createElement('canvas');
  image.className = 'post-kill-still';
  image.width = 640;
  image.height = 480;
  image.setAttribute('aria-hidden', 'true');
  image.getContext('2d').drawImage(postKillImage, 0, 0, 640, 480);
  target.appendChild(image);
}

function button(text, className, action, { html = false } = {}) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'scene-button ' + className;
  control.dataset.appearance = 'control';
  control.disabled = true;
  control.setAttribute('aria-label', text.replace(/<[^>]*>/g, ''));
  const label = document.createElement('span');
  label.className = 'copy';
  label.dataset.pixel = '';
  if (html) label.innerHTML = text; else label.textContent = text;
  control.appendChild(label);
  control.addEventListener('click', () => { unlockSound(); act(action); });
  layout.appendChild(control);
  return control;
}

function orb(visitor = false, target = layout) {
  postKillStill(target);
  if (!visitor) return;
  const mask = document.createElement('div');
  mask.className = 'visitor-mask';
  const portrait = document.createElement('img');
  portrait.src = 'assets/figma/3a-imgUntorraBooklet3Copy21.png';
  portrait.alt = '';
  mask.appendChild(portrait);
  target.appendChild(mask);
}

function face(frame) {
  const container = document.createElement('div');
  container.className = 'large-face' + (frame === '3a' ? ' old-face' : '');
  const portrait = document.createElement('img');
  portrait.src = 'assets/figma/3a-imgUntorraBooklet3Copy21.png';
  portrait.alt = '';
  container.appendChild(portrait);
  layout.appendChild(container);
}

function nameEchoes(threatening) {
  const name = state.god.name;
  const size = fitTextSize(name, 16, 400);
  const colors = threatening
    ? ['#ed0000', '#db0000', '#bf0000', '#790000', '#000', '#790000', '#bf0000', '#db0000', '#ed0000']
    : ['#1a1a1a', '#2c2c2c', '#484848', '#7f7f7f', '#fff', '#7f7f7f', '#484848', '#2c2c2c', '#1a1a1a'];
  const positions = [167, 183, 198, 214, 230, 246, 262, 278, 294];
  positions.forEach((top, index) => copy(name, 115, top, { size, color: colors[index], width: 410, center: true, appearance: index === 4 ? 'main' : 'echo', voice: 'god', atomicWords: index === 4 ? [name] : [] }));
}

function fitTextSize(text, size, width) {
  const measurement = document.createElement('canvas').getContext('2d');
  measurement.font = `${size}px Quantico`;
  const spacing = size * 0.4;
  const measured = Array.from(text).reduce((sum, character) => sum + measurement.measureText(character).width + spacing, -spacing);
  return size * Math.min(1, width / Math.max(1, measured));
}

function buildScene(id) {
  if (id === '1') {
    copy('????who are you????', 111, 192, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    copy('WHO ARE YOU', 191, 224, { size: 24, voice: 'god' });
    copy('?who are you', 182, 240, { size: 24, color: '#484848', appearance: 'echo' });
    copy('who are you??', 205, 208, { size: 24, color: '#484848', appearance: 'echo' });
    copy('???who are you', 135, 256, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    const label = copy('enter your name', 83, 359, { color: '#484848', appearance: 'control' });
    label.id = 'name-label';
    label.classList.add('name-label');
    label.style.left = 'var(--name-entry-inset)';
    label.style.top = 'calc(-32px * var(--ending-text-scale))';
    delete label.dataset.appearance;
    const form = document.createElement('form');
    form.className = 'name-entry';
    form.dataset.appearance = 'control';
    form.appendChild(label);
    const input = document.createElement('input');
    input.id = 'player-name';
    input.className = 'name-field';
    input.type = 'text';
    input.name = 'player-name';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.maxLength = NAME_MAX_LENGTH * 2;
    input.required = true;
    input.disabled = true;
    input.enterKeyHint = 'go';
    input.setAttribute('aria-labelledby', label.id);
    input.title = `Up to ${NAME_MAX_LENGTH} characters. Press Enter to continue.`;
    input.value = state.name;
    form.appendChild(input);
    const mirror = document.createElement('p');
    mirror.className = 'copy name-field-text';
    mirror.dataset.singleLine = 'true';
    mirror.setAttribute('aria-hidden', 'true');
    form.appendChild(mirror);
    let renderedValue = null, renderedWidth = null;
    const updateMirror = () => {
      if (!input.isConnected || !input.clientWidth) return;
      const fieldStyle = getComputedStyle(input);
      const width = input.clientWidth - parseFloat(fieldStyle.paddingLeft) - parseFloat(fieldStyle.paddingRight);
      if (!(width > 0)) return;
      if (renderedValue !== input.value || renderedWidth !== width) {
        form.style.setProperty('--name-entry-inset', `${parseFloat(fieldStyle.borderLeftWidth) + parseFloat(fieldStyle.paddingLeft)}px`);
        const scale = parseFloat(getComputedStyle(document.body).getPropertyValue('--ending-text-scale'));
        const size = fitTextSize(input.value, 16 * scale, width - 2);
        input.style.fontSize = mirror.style.fontSize = `${size}px`;
        input.style.letterSpacing = `${size * 0.4}px`;
        mirror.style.width = `${width}px`;
        mirror.textContent = input.value;
        pixelize(mirror);
        renderedValue = input.value;
        renderedWidth = width;
      }
      const model = textModels.get(mirror);
      model.offsetX = -input.scrollLeft;
      model.draw();
    };
    const enforceLimit = () => {
      const limited = limitNameInput(input.value);
      if (limited === input.value) return;
      const caret = Math.min(input.selectionStart ?? limited.length, limited.length);
      input.value = limited;
      input.setSelectionRange(caret, caret);
    };
    form.addEventListener('submit', event => {
      event.preventDefault();
      const name = cleanName(input.value);
      if (!name) { input.setCustomValidity('Enter your name'); input.reportValidity(); return; }
      state.name = name;
      unlockSound();
      act('name');
    });
    input.addEventListener('input', event => {
      input.setCustomValidity('');
      if (!event.isComposing) enforceLimit();
      updateMirror();
      requestAnimationFrame(() => { if (input.isConnected) updateMirror(); });
      if (event.isComposing) return;
      if (audio.context?.state !== 'running') unlockSound();
      typingAudio.play('player');
    });
    input.addEventListener('compositionend', () => { enforceLimit(); updateMirror(); });
    input.addEventListener('scroll', updateMirror);
    input.addEventListener('select', () => requestAnimationFrame(() => { if (input.isConnected) updateMirror(); }));
    layout.appendChild(form);
    nameEntryResize = new ResizeObserver(updateMirror);
    nameEntryResize.observe(form);
    updateMirror();
  } else if (id === '2') {
    copy('??have you come to', 126, 187, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    copy('have you come to', 150, 202, { size: 24, color: '#484848', voice: 'god' });
    copy('take <span style="color:#fff">UNTORRA</span> FROM ME?', 72, 222, { size: 24, color: '#c4c4c4', html: true, voice: 'god', atomicWords: ['UNTORRA'] });
    copy('MY UNTORRA??', 176, 240, { size: 24, color: '#464646', appearance: 'echo' });
    copy('!!!it’s MINE!!!!!!', 155, 259, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    copy('leave', 137, 373, { color: '#484848', appearance: 'control' });
    copy('???', 450, 373, { color: '#484848', appearance: 'control' });
    button('NO', 'no-button', 'decline');
    button('YES', 'yes-button', 'take');
  } else if (id === '4a') {
    postKillStill();
    copy('the keeper is dead', 192, 424, { color: '#f00' });
  } else if (id === '5a') {
    postKillStill();
    copy('you have become the new one', 205, 412, { color: '#f00', width: 229, center: true });
  } else if (id === '6a') {
    postKillStill();
    const caption = copy('enjoy the eternity', 320, 425, { color: '#f00', width: 346, center: true });
    caption.style.transform = 'translate(-50%, 0)';
  } else if (id === '6a-silence') {
    postKillStill();
  } else if (isTripScene(id)) {
    if (id === '7a') {
      const caption = copy('enjoy UNTORRA', 320, 240, { color: '#f00', width: 229, center: true, appearance: 'timed' });
      caption.classList.add('trip-caption', 'first-trip-caption');
      caption.style.opacity = '1';
      caption.style.transform = 'translate(-50%, -50%)';
      caption.hidden = true;
    } else {
      const caption = copy('he’s no longer a threat', 138, 424, { color: '#f00', width: 365, center: true });
      caption.classList.add('trip-caption');
      caption.dataset.holdMs = '2000';
    }
  } else if (['8a', '9a', '10a', '11a', '12d', '13d'].includes(id)) {
    orb(true);
    if (id === '9a') button('WHO ARE YOU?', 'light-button who-button', 'ask-name');
    if (id === '10a') {
      const text = `my name is ${state.visitor.name}`;
      copy(text, 90, 312, { size: fitTextSize(text, 13, 458), width: 460, center: true, translate: false });
    }
    if (id === '11a') button('have you come to <span style="color:#f00">TAKE UNTORRA FROM ME?</span>', 'light-button claim-button', 'ask-claim', { html: true });
    if (id === '12d') copy('no', 309, 312, { size: 13, translate: false });
    if (id === '13d') {
      button('KILL HIM', 'light-button kill-button', 'kill');
      button('LET HIM GO', 'light-button release-button', 'release');
    }
  } else if (id === '12a') {
    face('12a');
    copy('yes', 300, 394, { appearance: 'instant', translate: false });
  } else if (id === '13a') {
    const caption = copy('you are no longer a keeper', 162, 229, { color: '#f00', appearance: 'timed' });
    caption.classList.add('god-death-caption');
    caption.style.opacity = '1';
    caption.hidden = true;
  } else if (id === '4b') {
    copy('the keeper let you go', 197, 240);
  } else if (id === '5b') {
    copy('as a sign of encouragement\nor out of centuries-old loneliness,\nhe told you his name', 96, 209, { width: 488, center: true });
  } else if (id === '6b') {
    nameEchoes(false);
  } else if (id === '4c') {
    copy('the keeper didn’t let you go', 151, 230, { color: '#000' });
  } else if (id === '5c') {
    copy('as a sign of intimidation\nhe told you his name', 136, 224, { color: '#000', width: 368, center: true });
  } else if (id === '6c') {
    nameEchoes(true);
  } else if (id === '14e') {
    orb();
    const departing = document.createElement('div');
    departing.className = 'departing-visitor';
    layout.appendChild(departing);
    orb(true, departing);
    copy('he left', 277, 427, { color: '#f00' });
  }
}

function resize() {
  nativeScale = stage.clientWidth / 640;
  if (layout) layout.style.transform = `scale(${nativeScale})`;
}

function fadeElements(elements, duration) {
  for (const element of elements) {
    element.style.opacity = '1';
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, fill: 'both', easing: 'ease-out' });
  }
}

function startEchoTranslation(elements, revealDuration, settings) {
  if (state.reduced) return;
  for (const element of elements) {
    const model = textModels.get(element);
    const frames = echoTranslationFrames(model.text, { settings });
    if (!frames.length) continue;
    const sequence = new Sequence();
    echoPresentations.add(sequence);
    if (document.hidden || tools.open || pauseInput.checked || hostPaused || transitioning || waitingForGesture) sequence.pause('ui');
    sequence.play([
      { duration: revealDuration },
      ...frames.map(frame => ({
        duration: frame.duration,
        run: () => { if (element.isConnected) model.drawEcho(frame.decoded, frame.flickering, frame.revision); },
      })),
    ], () => { echoPresentations.delete(sequence); });
  }
}

function presentText(id) {
  const settings = getTextSettings();
  if (id === '13a') {
    clock.resume('text');
    stage.dataset.presentation = 'ready';
    presentation.play(state.reduced ? [{ duration: 2000 }, { duration: 0, run: () => {
      layout.querySelector('.god-death-caption').hidden = false;
    } }] : []);
    return;
  }
  const main = Array.from(layout.querySelectorAll('[data-appearance="main"]'));
  const echoes = Array.from(layout.querySelectorAll('[data-appearance="echo"]'));
  const controls = Array.from(layout.querySelectorAll('[data-appearance="control"]'));
  if (!state.reduced && settings.echoShake > 0) for (const element of echoes) {
    const animation = element.animate(echoJitterFrames(Math.random, nativeScale, settings), { duration: settings.echoMotion * (0.8 + Math.random() * 0.4), iterations: Infinity });
    animation.id = 'echo-jitter';
  }
  const revealDuration = state.reduced ? Math.min(200, settings.revealFade) : settings.revealFade;
  const echoStagger = state.reduced ? Math.min(80, settings.echoStagger) : settings.echoStagger;
  const departing = layout.querySelector('.departing-visitor');
  const departureDuration = state.reduced ? 200 : 1200;
  const steps = departing ? [{ duration: departureDuration, run: () => {
    departing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: departureDuration, fill: 'both', easing: 'ease-in-out' });
  } }] : [{ duration: settings.startPause }];
  for (const element of [...main, ...echoes, ...controls]) element.style.opacity = '0';
  for (const element of echoes) {
    const model = textModels.get(element);
    if (state.reduced) model.draw(); else model.drawEcho();
  }
  for (const control of controls) control.inert = true;
  for (const element of main) {
    const model = textModels.get(element);
    const translate = !state.reduced && element.dataset.translation !== 'human';
    if (translate) model.drawAlien(0); else model.draw(0);
    steps.push({ duration: 0, run: () => { element.style.opacity = '1'; } });
    const atomicWords = JSON.parse(element.dataset.atomicWords || '[]');
    const tokens = typingTokens(model.text, { voice: element.dataset.voice, atomicWords, settings });
    if (translate) {
      for (const frame of concurrentTypingFrames(model.text, tokens, { atomicWords, voice: element.dataset.voice, settings })) steps.push({
        duration: frame.duration,
        run: () => {
          stage.dataset.presentation = frame.type === 'typing' ? 'typing' : 'translating';
          model.drawDecoded(frame.visible, frame.decoded, frame.flickering, frame.revision);
          if (frame.sound || frame.letterSound) playTypingToken(frame);
        },
      });
      steps.push({ duration: settings.decodeSettle, run: () => { model.draw(model.text.length); } });
    } else {
      for (const token of tokens) {
        if (token.sound === 'untorra') {
          let end = token.start;
          for (const character of model.text.slice(token.start, token.end)) {
            end += character.length;
            const position = end;
            steps.push({ duration: settings.untorraLetterInterval, run: () => {
              model.draw(position);
              if (/\S/u.test(character)) playTypingToken({ letterSound: 'untorra-type', sound: position === token.end ? 'untorra' : null });
            } });
          }
        } else steps.push({ duration: token.duration, run: () => { model.draw(token.end); playTypingToken(token); } });
      }
      steps.push({ duration: 180 });
    }
    if (element.dataset.holdMs) {
      steps.push({ duration: Number(element.dataset.holdMs), run: () => { stage.dataset.presentation = 'reading'; } });
      steps.push({ duration: revealDuration, run: () => {
        stage.dataset.presentation = 'fading';
        element.style.opacity = '0';
        element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: revealDuration, fill: 'both', easing: 'ease-out' });
      } });
      steps.push({ duration: 0, run: () => { element.hidden = true; } });
    }
  }
  if (echoes.length) {
    const center = element => element.offsetTop + element.offsetHeight / 2;
    const groups = echoRevealGroups(main.map(center), echoes.map(center));
    groups.forEach((indices, index) => {
      const group = indices.map(position => echoes[position]);
      for (const element of group) element.dataset.echoRank = String(index);
      steps.push({ duration: index === groups.length - 1 ? revealDuration + 100 : echoStagger, run: () => {
        stage.dataset.presentation = 'echoes';
        fadeElements(group, revealDuration);
        startEchoTranslation(group, revealDuration, settings);
      } });
    });
  }
  if (controls.length) steps.push({ duration: revealDuration, run: () => {
    stage.dataset.presentation = 'controls';
    fadeElements(controls, revealDuration);
  } });
  const hasPresentation = main.length || echoes.length || controls.length;
  if (hasPresentation && !sceneVideo) clock.pause('text'); else clock.resume('text');
  stage.dataset.presentation = main.length ? 'typing' : controls.length ? 'controls' : 'ready';
  presentation.play(hasPresentation ? steps : [], () => {
    stage.dataset.presentation = 'ready';
    for (const control of controls) {
      control.inert = false;
      if (control.matches('button, input')) control.disabled = false;
      for (const field of control.querySelectorAll('button, input')) field.disabled = false;
    }
    if (!document.hidden && !tools.open && !pauseInput.checked && !transitioning && !waitingForGesture) {
      layout.querySelector('.name-field')?.focus({ preventScroll: true });
    }
    clock.resume('text');
  });
}

function showScene(id) {
  const definition = sceneById(id);
  if (!definition || !ready) return;
  nameEntryResize?.disconnect();
  nameEntryResize = null;
  firstTripCaption.cancel();
  godDeathCaption.cancel();
  stopScreenShake();
  presentation.cancel();
  for (const sequence of echoPresentations) sequence.cancel();
  echoPresentations.clear();
  typingAudio.stop();
  for (const animation of sceneHost.getAnimations({ subtree: true })) animation.cancel();
  state.scene = id;
  document.body.style.setProperty('--ending-ink', getTextSettings().alienColor);
  sceneHost.dataset.screen = id;
  sceneHost.dataset.tone = definition.tone;
  stage.dataset.screen = id;
  stage.dataset.reduced = String(state.reduced);
  stage.dataset.trip = String(isTripScene(id));
  stage.dataset.animated = String(isTripScene(id) || (!state.reduced && ['3a', '3a-after', '3c', '13a', '14d'].includes(id)));
  layout = document.createElement('section');
  layout.className = 'scene-layout';
  layout.setAttribute('aria-label', definition.title);
  if (definition.node) layout.dataset.figmaNode = definition.node;
  sceneHost.replaceChildren(layout);
  resize();
  buildScene(id);
  stage.dataset.matchedStill = String(!!layout.querySelector('.post-kill-still'));
  for (const paragraph of layout.querySelectorAll('[data-pixel]')) pixelize(paragraph);
  setVideoScene(id);
  firstTripCaption.bind(id === '7a' ? sceneVideo : null, layout.querySelector('.first-trip-caption'));
  godDeathCaption.bind(id === '13a' && !state.reduced ? sceneVideo : null, layout.querySelector('.god-death-caption'));
  renderer.setScene(sceneVideo ? null : id, state.reduced, definition.duration);
  audio.setScene(id);
  picker.value = id;
  status.textContent = `${id === 'end' ? 'Конец ' + (state.outcome ?? 'теста') + '. Повтор — «С начала».' : 'screen ' + id + ' · ' + definition.title}${clock.reasons.size ? ' · пауза' : ''}`;
  skipButton.disabled = !transitionFor(id, 'auto', state);
  exportButton.disabled = state.decisions.length === 0;
  updateFixtureSummary();
  document.getElementById('run-summary').textContent = `Встреч: ${state.encounters} · Ветки: ${state.branches.join(' → ') || '—'}${state.preview ? ' · просмотр отдельного кадра' : ''}`;
  document.dispatchEvent(new CustomEvent('untorra:screenchange', { detail: { title: definition.title, image: `prototype/${id}`, noVignette: true } }));
  const duration = sceneVideo && Number.isFinite(sceneVideo.duration) ? sceneVideo.duration * 1000 : definition.duration;
  clock.enter(duration);
  presentText(id);
  syncSuspension();
  notifyHost('scene', { scene: { id, title: definition.title, bypass: stage.dataset.animated === 'true' || stage.dataset.matchedStill === 'true' } });
  if (embedded && id === 'end' && !completionReported) {
    completionReported = true;
    notifyHost('complete', { result: decisionSnapshot(state) });
  }
}

function changeScene(action) {
  const destination = advanceRun(state, action);
  if (!destination) return;
  repository.capture(decisionSnapshot(state));
  showScene(destination);
}

function animateBlack(from, to) {
  fadeOverlay.hidden = false;
  fadeOverlay.style.opacity = String(to);
  const animation = fadeOverlay.animate([{ opacity: from }, { opacity: to }], { duration: FADE_MS, fill: 'both', easing: 'ease-in-out' });
  if (document.hidden || tools.open || pauseInput.checked) animation.pause();
}

function act(action) {
  if (transitioning || waitingForGesture) return;
  const destination = transitionFor(state.scene, action, state);
  if (!destination) return;
  const textScene = layout.querySelector('[data-appearance="main"], [data-appearance="control"]');
  const fade = !isSeamlessTransition(state.scene, destination, action) && (action !== 'auto' || (!sceneVideo && state.scene !== '13a' && textScene));
  if (!fade) { changeScene(action); return; }
  transitioning = true;
  sceneHost.inert = true;
  clock.pause('transition');
  syncSuspension();
  transition.play([
    { duration: FADE_MS, run: () => animateBlack(0, 1) },
    { duration: FADE_MS, run: () => { changeScene(action); animateBlack(1, 0); } },
  ], () => {
    transitioning = false;
    sceneHost.inert = false;
    fadeOverlay.hidden = true;
    for (const animation of fadeOverlay.getAnimations()) animation.cancel();
    clock.resume('transition');
    syncSuspension();
  });
}

function cancelTransition() {
  transition.cancel();
  transitioning = false;
  sceneHost.inert = false;
  fadeOverlay.hidden = true;
  for (const animation of fadeOverlay.getAnimations()) animation.cancel();
  clock.resume('transition');
  waitingForGesture = false;
  startButton.hidden = true;
  clock.resume('gesture');
}

function configuredRun(name = '') {
  const reduced = state.reduced;
  const cast = state.plan.id === 'archive' ? { god: state.god, visitors: state.plan.visitors } : state.god.source === 'server-record' ? { god: state.god, visitors: [] } : undefined;
  state = createRun({ godId: godInput.value, visitorPlanId: visitorsInput.value, name, cast });
  state.reduced = reduced;
}

function updateFixtureSummary() {
  document.getElementById('fixture-summary').textContent = `${state.plan.id === 'archive' || state.god.source === 'server-record' ? 'Записи из архива.' : 'Локальные резервные записи.'} Бог: ${state.god.name} (${state.god.response === 'release' ? 'отпустит' : 'убьёт'}). ${state.visitor ? 'Гость: ' + state.visitor.name + ' · ' + (state.visitor.decision === 'take' ? 'YES' : 'NO') + '.' : ''}`;
}

function setVideoScene(id) {
  const next = sceneVideos.get(id) || null;
  const previous = sceneVideo;
  const handoff = ++stillHandoff;
  const retainLastFrame = previous === afterKillVideo && id === '4a' && !state.reduced;
  for (const video of videos) {
    if (retainLastFrame && video === previous) continue;
    video.hidden = video !== next;
    if (id !== videoScene || video !== next) {
      video.pause();
      video.currentTime = 0;
    }
  }
  sceneVideo = next;
  videoScene = next ? id : null;
  if (next && !state.reduced) clock.pause('video'); else clock.resume('video');
  if (retainLastFrame) requestAnimationFrame(() => requestAnimationFrame(() => {
    if (stillHandoff !== handoff) return;
    previous.hidden = true;
    previous.pause();
    previous.currentTime = 0;
  }));
}

function syncSuspension() {
  const suspended = document.hidden || tools.open || pauseInput.checked || hostPaused;
  if (hostPaused) { clock.pause('host'); presentation.pause('host'); }
  else { clock.resume('host'); presentation.resume('host'); }
  const contentSuspended = suspended || transitioning || waitingForGesture;
  if (contentSuspended) renderer?.suspend(); else renderer?.resume();
  if (contentSuspended) presentation.pause('ui'); else presentation.resume('ui');
  for (const sequence of echoPresentations) {
    if (contentSuspended) sequence.pause('ui'); else sequence.resume('ui');
  }
  if (suspended) transition.pause('ui'); else transition.resume('ui');
  typingAudio.setSuspended(contentSuspended, audio.enabled);
  if (contentSuspended || !audio.enabled) stopScreenShake();
  for (const video of videos) video.muted = !audio.enabled || !videoSoundUnlocked;
  if (sceneVideo) {
    const video = sceneVideo;
    if (contentSuspended || state.reduced) video.pause();
    else if (video.paused) video.play().catch(error => {
      if (sceneVideo !== video || state.reduced || document.hidden || tools.open || pauseInput.checked || transitioning || waitingForGesture || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError' && !video.muted) {
        videoSoundUnlocked = false;
        syncSuspension();
        return;
      }
      clock.pause('video');
      tools.open = true;
      status.textContent = 'Видео приостановлено. Закрой панель, чтобы повторить запуск. ' + error.message;
    });
    else if (video.readyState >= 3) clock.resume('video');
  }
  syncSceneAnimations(sceneHost.getAnimations({ subtree: true }), { suspended, transitioning, waitingForGesture });
  syncAnimations(fadeOverlay.getAnimations(), suspended);
  audio.hidden = contentSuspended || !!videoScene;
  audio.update();
}

function unlockSound() {
  videoSoundUnlocked = true;
  audio.unlock();
  const soundReady = typingAudio.unlock(audio.context);
  syncSuspension();
  return soundReady;
}

async function startEnding() {
  if (!waitingForGesture || starting) return;
  starting = true;
  await unlockSound();
  starting = false;
  if (!waitingForGesture) return;
  waitingForGesture = false;
  startButton.hidden = true;
  clock.resume('gesture');
  syncSuspension();
}

mountTextSettings(tools, {
  enabled: !embedded,
  onReplay: () => {
    if (!ready) return false;
    const input = layout?.querySelector('.name-field');
    if (input) state.name = input.value;
    cancelTransition();
    showScene(state.scene);
    if (waitingForGesture) startEnding();
    return true;
  },
});

startButton.addEventListener('click', startEnding);
stage.addEventListener('pointerdown', () => { if (videoScene) unlockSound(); });
for (const video of videos) {
  video.addEventListener('loadedmetadata', () => {
    if (sceneVideo === video && Number.isFinite(video.duration)) clock.enter(video.duration * 1000);
  });
  video.addEventListener('ended', () => { if (sceneVideo === video && !state.reduced) act('auto'); });
  for (const event of ['waiting', 'pause']) video.addEventListener(event, () => {
    if (sceneVideo === video && !state.reduced) clock.pause('video');
  });
  video.addEventListener('playing', () => {
    if (sceneVideo === video && !state.reduced && !document.hidden && !tools.open && !pauseInput.checked && !transitioning && !waitingForGesture) clock.resume('video');
    else video.pause();
    if (sceneVideo === video) { firstTripCaption.refresh(); godDeathCaption.refresh(); }
  });
  video.addEventListener('seeked', () => { if (sceneVideo === video) { firstTripCaption.refresh(); godDeathCaption.refresh(); } });
  video.addEventListener('canplay', () => { if (ready && sceneVideo === video) syncSuspension(); });
  video.addEventListener('error', () => {
    if (sceneVideo !== video) return;
    clock.pause('video');
    tools.open = true;
    status.textContent = 'Не удалось загрузить видео сцены. Обнови страницу или выбери другой кадр.';
  });
}

for (const profile of GOD_PROFILES) {
  const option = document.createElement('option');
  option.value = profile.id;
  option.textContent = `${profile.name} · ${profile.response === 'release' ? 'отпустит — B' : 'убьёт — C'}`;
  godInput.appendChild(option);
}
for (const plan of VISITOR_PLANS) {
  const option = document.createElement('option');
  option.value = plan.id;
  option.textContent = plan.title;
  visitorsInput.appendChild(option);
}
godInput.value = state.god.id;
godInput.addEventListener('change', () => {
  if (!['1', '2'].includes(state.scene)) return;
  const profile = GOD_PROFILES.find(profile => profile.id === godInput.value);
  if (!profile) return;
  state.god = profile;
  updateFixtureSummary();
});
visitorsInput.value = state.plan.id;
for (const scene of SCENES) {
  const option = document.createElement('option');
  option.value = scene.id;
  option.textContent = `${scene.id} · ${scene.title}`;
  picker.appendChild(option);
}
picker.addEventListener('change', () => {
  cancelTransition();
  unlockSound();
  const id = picker.value;
  configuredRun(state.name);
  previewScene(state, id);
  godInput.value = state.god.id;
  showScene(id);
});
tools.addEventListener('toggle', () => {
  if (tools.open) clock.pause('tools'); else clock.resume('tools');
  syncSuspension();
});
pauseInput.addEventListener('change', () => {
  if (pauseInput.checked) clock.pause('manual'); else clock.resume('manual');
  syncSuspension();
});
document.getElementById('sound-enabled').addEventListener('change', event => { audio.enabled = event.target.checked; unlockSound(); });
reducedInput.checked = state.reduced;
reducedInput.addEventListener('change', () => {
  cancelTransition();
  state.reduced = reducedInput.checked;
  document.body.classList.toggle('reduced-motion', state.reduced);
  showScene(state.scene);
});
document.body.classList.toggle('reduced-motion', state.reduced);
document.getElementById('restart').addEventListener('click', () => {
  cancelTransition();
  unlockSound();
  configuredRun();
  pauseInput.checked = false;
  clock.resume('manual');
  showScene('1');
  tools.open = false;
});
document.getElementById('next-scene').addEventListener('click', () => {
  cancelTransition();
  changeScene('auto');
});
exportButton.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(decisionSnapshot(state), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'untorra-ending-decisions.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clock.pause('hidden'); else clock.resume('hidden');
  syncSuspension();
});
document.addEventListener('keydown', event => {
  if (embedded && !event.repeat && (event.key === 'Escape' || event.code === 'F8')) {
    event.preventDefault();
    if (event.code === 'F8') notifyHost('effects', { shiftKey: event.shiftKey });
    return;
  }
  if (waitingForGesture && !tools.open && ['Enter', ' '].includes(event.key)) { event.preventDefault(); startEnding(); return; }
  if (event.key === 'Escape' && tools.open) { tools.open = false; event.preventDefault(); }
});
new ResizeObserver(resize).observe(stage);

async function init() {
  try {
    const castReady = repository.loadCast(state.runId);
    const alienReady = loadAlienGlyphAtlas();
    const [portraits, atlas] = await Promise.all([Promise.all(assets.map(async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return image;
    })), alienReady]);
    postKillImage = portraits[assets.indexOf('assets/video/after-kill-final-frame.png')];
    alienAtlas = atlas;
    const cast = await castReady;
    if (cast) {
      const reduced = state.reduced;
      state = createRun({ runId: state.runId, godId: state.god.id, cast });
      state.reduced = reduced;
    }
    await document.fonts.load('24px Quantico');
    await document.fonts.ready;
    renderer = new PsychedelicRenderer(document.getElementById('psyche'), portraits[0]);
    ready = true;
    stage.setAttribute('aria-busy', 'false');
    if (query.get('hold') === '1') { pauseInput.checked = true; clock.pause('manual'); }
    if (tools.open) clock.pause('tools');
    if (document.hidden) clock.pause('hidden');
    const requested = embedded ? null : query.get('screen');
    if (sceneById(requested)) previewScene(state, requested);
    godInput.value = state.god.id;
    if (!embedded && ['1', '2'].includes(state.scene)) {
      waitingForGesture = true;
      startButton.hidden = false;
      clock.pause('gesture');
      presentation.pause('ui');
    }
    showScene(state.scene);
    document.body.classList.add('ready');
    notifyHost('ready');
  } catch (error) {
    tools.open = true;
    stage.setAttribute('aria-busy', 'false');
    status.textContent = 'Не удалось загрузить локальные ассеты. Обнови страницу. ' + error.message;
    notifyHost('error');
  }
}

init();
