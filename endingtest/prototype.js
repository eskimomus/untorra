import { SCENES, GOD_PROFILES, VISITOR_PLANS, sceneById, cleanName, transitionFor, createRun, advanceRun, previewScene, decisionSnapshot, isTripScene, isSeamlessTransition, SceneClock } from './story.js?v=13';
import { PsychedelicRenderer, EndingAudio } from './psychedelic.js?v=15';
import { Sequence, TypingAudio, typingTokens, syncAnimations, syncSceneAnimations, echoRevealGroups, echoJitterFrames } from './text-presentation.js?v=9';
import { VideoCaption } from './video-presentation.js?v=4';

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
const transition = new Sequence();
const textModels = new WeakMap();
const firstTripCaption = new VideoCaption();
const godDeathCaption = new VideoCaption({ firstFrame: 60, lastFrame: 119 });
const FADE_MS = 400;
const query = new URLSearchParams(location.search);
let state = createRun();
state.reduced = preferences.matches;
const clock = new SceneClock(() => act('auto'));
let renderer;
let layout;
let nativeScale = 1;
let ready = false;
let videoScene = null;
let sceneVideo = null;
let videoSoundUnlocked = false;
let transitioning = false;
let waitingForGesture = false;
let starting = false;
let screenShake = null;

const assets = [
  'assets/figma/3a-imgUntorraBooklet3Copy21.png',
  'assets/figma/9a-imgUntorraBooklet3Copy21.svg',
  'assets/figma/9a-imgUntorraBooklet3Copy22.png',
  'assets/figma/12a-imgUntorraBooklet3Copy21.png',
  'assets/video/after-kill-final-frame.png',
];

function copy(text, left, top, { size = 16, color = '#fff', width, center = false, html = false, appearance = 'main', voice = 'player', atomicWords = [] } = {}) {
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
  layout.appendChild(paragraph);
  return paragraph;
}

function pixelize(paragraph) {
  const text = paragraph.textContent;
  const computed = getComputedStyle(paragraph);
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
      glyphs.push({ character, horizontal, vertical: lineIndex * size * 1.324 + size * 0.99, color: segment?.color || computed.color, end: sourceIndex + character.length });
      horizontal += measurement.measureText(character).width + spacing;
      sourceIndex += character.length;
    }
    sourceIndex += 1;
  }
  paragraph.setAttribute('aria-label', text);
  paragraph.replaceChildren(canvas);
  const model = { text, visible: text.length, offsetX: 0, draw: null };
  const draw = (visible = model.visible) => {
    model.visible = visible;
    context.clearRect(0, 0, available, height);
    for (const glyph of glyphs) {
      if (glyph.end > visible) continue;
      context.fillStyle = glyph.color;
      context.fillText(glyph.character, glyph.horizontal + model.offsetX, glyph.vertical);
    }
    if (paragraph.dataset.visibleCharacters !== String(visible)) paragraph.dataset.visibleCharacters = String(visible);
  };
  model.draw = draw;
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

function playTypingToken(token) {
  if (token.sound !== 'untorra') { if (token.sound) typingAudio.play(token.sound); return; }
  let shake;
  const voice = typingAudio.play('untorra', { onEnded: () => { if (shake) stopScreenShake(shake); } });
  if (state.reduced) return;
  stopScreenShake();
  const duration = voice?.duration || typingAudio.duration('untorra') || 0.5;
  shake = { frame: null, deadline: performance.now() + duration * 1000 };
  screenShake = shake;
  game.dataset.shaking = 'true';
  game.dataset.shakeDuration = String(duration);
  const update = () => {
    if (screenShake !== shake) return;
    if (!voice && performance.now() >= shake.deadline) { stopScreenShake(shake); return; }
    game.style.setProperty('--screen-shake-x', `${Math.round((Math.random() - 0.5) * 6 * nativeScale)}px`);
    game.style.setProperty('--screen-shake-y', `${Math.round((Math.random() - 0.5) * 6 * nativeScale)}px`);
    shake.frame = requestAnimationFrame(update);
  };
  update();
}

function postKillStill(target = layout) {
  const image = document.createElement('img');
  image.className = 'post-kill-still';
  image.src = 'assets/video/after-kill-final-frame.png';
  image.alt = '';
  image.width = 640;
  image.height = 480;
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
  const measurement = document.createElement('canvas').getContext('2d');
  measurement.font = '16px Quantico';
  const measured = Array.from(name).reduce((sum, character) => sum + measurement.measureText(character).width + 6.4, -6.4);
  const size = Math.min(16, 16 * 400 / Math.max(1, measured));
  const colors = threatening
    ? ['#ed0000', '#db0000', '#bf0000', '#790000', '#000', '#790000', '#bf0000', '#db0000', '#ed0000']
    : ['#1a1a1a', '#2c2c2c', '#484848', '#7f7f7f', '#fff', '#7f7f7f', '#484848', '#2c2c2c', '#1a1a1a'];
  const positions = [167, 183, 198, 214, 230, 246, 262, 278, 294];
  positions.forEach((top, index) => copy(name, 115, top, { size, color: colors[index], width: 410, center: true, appearance: index === 4 ? 'main' : 'echo', voice: 'god' }));
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
    const form = document.createElement('form');
    form.dataset.appearance = 'control';
    const input = document.createElement('input');
    input.id = 'player-name';
    input.className = 'name-field';
    input.type = 'text';
    input.name = 'player-name';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.maxLength = 48;
    input.required = true;
    input.disabled = true;
    input.enterKeyHint = 'go';
    input.setAttribute('aria-labelledby', label.id);
    input.title = 'Enter your name, then press Enter';
    input.value = state.name;
    form.appendChild(input);
    const mirror = document.createElement('p');
    mirror.className = 'copy name-field-text';
    mirror.style.width = '474px';
    mirror.dataset.singleLine = 'true';
    mirror.setAttribute('aria-hidden', 'true');
    form.appendChild(mirror);
    let renderedValue = null;
    const updateMirror = () => {
      if (renderedValue !== input.value) {
        mirror.textContent = input.value;
        pixelize(mirror);
        renderedValue = input.value;
      }
      const model = textModels.get(mirror);
      model.offsetX = -input.scrollLeft;
      model.draw();
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
      updateMirror();
      requestAnimationFrame(() => { if (input.isConnected) updateMirror(); });
      if (event.isComposing) return;
      if (audio.context?.state !== 'running') unlockSound();
      typingAudio.play('player');
    });
    input.addEventListener('scroll', updateMirror);
    input.addEventListener('select', () => requestAnimationFrame(() => { if (input.isConnected) updateMirror(); }));
    layout.appendChild(form);
    updateMirror();
  } else if (id === '2') {
    copy('??have you come to', 126, 187, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    copy('have you come to', 150, 202, { size: 24, color: '#484848', voice: 'god' });
    copy('take <span style="color:#fff">UNTORRA</span> FROM ME?', 72, 222, { size: 24, color: '#c4c4c4', html: true, voice: 'god', atomicWords: ['UNTORRA'] });
    copy('MY UNTORRA??', 176, 240, { size: 24, color: '#464646', appearance: 'echo' });
    copy('!!!it’s MINE!!!!!!', 155, 259, { size: 24, color: '#1a1a1a', appearance: 'echo' });
    copy('leave', 137, 359, { color: '#484848', appearance: 'control' });
    copy('???', 450, 359, { color: '#484848', appearance: 'control' });
    button('NO', 'no-button', 'decline');
    button('YES', 'yes-button', 'take');
  } else if (id === '4a') {
    postKillStill();
    copy('the old god is dead', 192, 424, { color: '#f00' });
  } else if (id === '5a') {
    postKillStill();
    copy('you have become the new god', 205, 412, { color: '#f00', width: 229, center: true });
  } else if (id === '6a') {
    postKillStill();
    copy('enjoy the endless', 128, 425, { color: '#f00', width: 346, center: true });
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
    if (id === '10a') copy(`my name is ${state.visitor.name}`, 240, 312, { size: 13 });
    if (id === '11a') button('have you come to <span style="color:#f00">TAKE UNTORRA FROM ME?</span>', 'light-button claim-button', 'ask-claim', { html: true });
    if (id === '12d') copy('no', 309, 312, { size: 13 });
    if (id === '13d') {
      button('KILL HIM', 'light-button kill-button', 'kill');
      button('LET HIM GO', 'light-button release-button', 'release');
    }
  } else if (id === '12a') {
    face('12a');
    copy('yes', 300, 394, { appearance: 'instant' });
  } else if (id === '13a') {
    const caption = copy('you are no longer a god', 162, 229, { color: '#f00', appearance: 'timed' });
    caption.classList.add('god-death-caption');
    caption.style.opacity = '1';
    caption.hidden = true;
  } else if (id === '4b') {
    copy('the god let you go', 197, 240);
  } else if (id === '5b') {
    copy('as a sign of encouragement\nor out of centuries-old loneliness,\nhe told you his name', 96, 209, { width: 488, center: true });
  } else if (id === '6b') {
    nameEchoes(false);
  } else if (id === '4c') {
    copy('the god didn’t let you go', 151, 230, { color: '#000' });
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

function presentText(id) {
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
  if (!state.reduced) for (const element of echoes) {
    const animation = element.animate(echoJitterFrames(Math.random, nativeScale), { duration: 800 + Math.random() * 400, iterations: Infinity });
    animation.id = 'echo-jitter';
  }
  const revealDuration = state.reduced ? 200 : 700;
  const echoStagger = state.reduced ? 80 : 180;
  const departing = layout.querySelector('.departing-visitor');
  const departureDuration = state.reduced ? 200 : 1200;
  const steps = departing ? [{ duration: departureDuration, run: () => {
    departing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: departureDuration, fill: 'both', easing: 'ease-in-out' });
  } }] : [{ duration: 180 }];
  for (const element of [...main, ...echoes, ...controls]) element.style.opacity = '0';
  for (const control of controls) control.inert = true;
  for (const element of main) {
    const model = textModels.get(element);
    model.draw(0);
    steps.push({ duration: 0, run: () => { element.style.opacity = '1'; } });
    const tokens = typingTokens(model.text, { voice: element.dataset.voice, atomicWords: JSON.parse(element.dataset.atomicWords || '[]') });
    for (const token of tokens) steps.push({
      duration: token.duration,
      run: () => {
        model.draw(token.end);
        playTypingToken(token);
      },
    });
    steps.push({ duration: 180 });
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
  firstTripCaption.cancel();
  godDeathCaption.cancel();
  stopScreenShake();
  presentation.cancel();
  typingAudio.stop();
  for (const animation of sceneHost.getAnimations({ subtree: true })) animation.cancel();
  state.scene = id;
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
}

function changeScene(action) {
  const destination = advanceRun(state, action);
  if (!destination) return;
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
  state = createRun({ godId: godInput.value, visitorPlanId: visitorsInput.value, name });
  state.reduced = reduced;
}

function updateFixtureSummary() {
  document.getElementById('fixture-summary').textContent = `Локальные записи, не сервер. Бог: ${state.god.name} (${state.god.response === 'release' ? 'отпустит' : 'убьёт'}). ${state.visitor ? 'Гость: ' + state.visitor.name + ' · ' + (state.visitor.decision === 'take' ? 'YES' : 'NO') + '.' : ''}`;
}

function setVideoScene(id) {
  const next = sceneVideos.get(id) || null;
  for (const video of videos) {
    video.hidden = video !== next;
    if (id !== videoScene || video !== next) {
      video.pause();
      video.currentTime = 0;
    }
  }
  sceneVideo = next;
  videoScene = next ? id : null;
  if (next && !state.reduced) clock.pause('video'); else clock.resume('video');
}

function syncSuspension() {
  const suspended = document.hidden || tools.open || pauseInput.checked;
  const contentSuspended = suspended || transitioning || waitingForGesture;
  if (contentSuspended) renderer?.suspend(); else renderer?.resume();
  if (contentSuspended) presentation.pause('ui'); else presentation.resume('ui');
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
  if (waitingForGesture && !tools.open && ['Enter', ' '].includes(event.key)) { event.preventDefault(); startEnding(); return; }
  if (event.key === 'Escape' && tools.open) { tools.open = false; event.preventDefault(); }
});
new ResizeObserver(resize).observe(stage);

async function init() {
  try {
    const portraits = await Promise.all(assets.map(async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return image;
    }));
    await document.fonts.load('24px Quantico');
    await document.fonts.ready;
    renderer = new PsychedelicRenderer(document.getElementById('psyche'), portraits[0]);
    ready = true;
    stage.setAttribute('aria-busy', 'false');
    if (query.get('hold') === '1') { pauseInput.checked = true; clock.pause('manual'); }
    if (tools.open) clock.pause('tools');
    if (document.hidden) clock.pause('hidden');
    const requested = query.get('screen');
    if (sceneById(requested)) previewScene(state, requested);
    godInput.value = state.god.id;
    if (['1', '2'].includes(state.scene)) {
      waitingForGesture = true;
      startButton.hidden = false;
      clock.pause('gesture');
      presentation.pause('ui');
    }
    showScene(state.scene);
    document.body.classList.add('ready');
  } catch (error) {
    tools.open = true;
    stage.setAttribute('aria-busy', 'false');
    status.textContent = 'Не удалось загрузить локальные ассеты. Обнови страницу. ' + error.message;
  }
}

init();
