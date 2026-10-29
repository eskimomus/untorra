/* Whole-stage Mac-palette dither and animated grain. F8 toggles the
 * postprocessing; per-frame vignette settings apply independently.
 */
(() => {
  'use strict';
  const STORE = 'untorra-full-dither-test';
  const MIX_STORE = 'untorra-full-dither-mix';
  const NOISE_STORE = 'untorra-screen-noise';
  const CRT_STORE = 'untorra-crt-scanlines';
  const BLOOM_STORE = 'untorra-screen-bloom';
  const VIGNETTE_STORE = 'untorra-vignette-v1';
  const VIGNETTE_DEFAULTS = {
    "renders/hub/hub%20closed.jpg": {"strength": 60, "size": 50},
    "renders/1/beach/1%20beach/beach%201%201.jpg": {"strength": 10, "size": 50},
    "renders/hub/1st.jpg": {"strength": 60, "size": 50},
    "renders/hub/2nd%20closed.jpg": {"strength": 60, "size": 50},
    "renders/hub/lever%20closed.jpg": {"strength": 60, "size": 50},
    "renders/hub/3rd.jpg": {"strength": 60, "size": 50},
    "renders/1/beach/1%20beach/beach%202%201.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/ezh%20(transmitter)/ezh%20inside.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/ezh%20(transmitter)/ezh%20inside%202.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/ezh%20(transmitter)/ezh%20mayak.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/ezh%20(transmitter)/ezh%20sea.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/1%20beach/beach%202%203.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/storage/storage%201.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/1%20beach/beach%202%202.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/1%20beach/beach%202%204.jpg": {"strength": 10, "size": 50},
    "renders/1/beach/1%20beach/beach%201%202.jpg": {"strength": 10, "size": 50},
    "renders/2/room%202/room2%201%201%20red.jpg": {"strength": 75, "size": 50},
    "renders/2/room%202/room2%201%202%20red.jpg": {"strength": 60, "size": 50},
    "renders/2/room%202/lift/lift%20panel%20red.jpg": {"strength": 75, "size": 50},
    "renders/2/greenhouse/greenhouse%201%201.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%202%201.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%203%201.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%204%201.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%203%204.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%203%202.jpg": {"strength": 40, "size": 50},
    "renders/2/greenhouse/greenhouse%202%202.jpg": {"strength": 40, "size": 50},
    "renders/2/room%202/cables/cables%203%201.jpg": {"strength": 40, "size": 50},
    "renders/hub/3rd%20open.jpg": {"strength": 60, "size": 50},
    "renders/3/tunnel/tunnel3%201%201.jpg": {"strength": 40, "size": 50},
    "renders/3/tower/tower%201%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%202%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%203%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%204%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%202%202.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%201%202.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%201%204.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%20lift/tower%20lift%201%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%20lift/tower%20lift%202%201.jpg": {"strength": 30, "size": 50},
    "renders/3/tower/tower%20lift/tower%20lift%201%202.jpg": {"strength": 30, "size": 50},
  };
  const NOISE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAP0lEQVR4nAE0AMv/AAAAAIiIiCIiIqqqqgDMzMxERETu7u5mZmYAMzMzu7u7ERERmZmZAP///3d3d93d3VVVVS+6F+nnC6oEAAAAAElFTkSuQmCC';
  const NS = 'http://www.w3.org/2000/svg';
  const inputs = {};
  const settings = {
    mix: { label: 'микс дизеринга', aria: 'Микс дизеринга', store: MIX_STORE },
    noise: { label: 'анимированный шум', aria: 'Анимированный шум', store: NOISE_STORE },
    crt: { label: 'полосы CRT', aria: 'Полосы CRT', store: CRT_STORE },
    bloom: { label: 'блум', aria: 'Блум', store: BLOOM_STORE },
  };
  const vignetteFields = {
    vignette: { label: 'сила виньетки', aria: 'Сила виньетки' },
    vignetteSize: { label: 'размер виньетки', aria: 'Размер виньетки' },
  };
  let enabled = true, mix = 0.32, noise = 0.38, crt = 0.1, bloom = 0.75;
  let stage, filter, mixNode, controls, enabledInput;
  let bloomMixNode, bloomBlurNode;
  let scanlineLayer, noiseLayer, noiseTexture, pipelineKey = '';
  let toast, toastTimer, currentScreen = null, vignettes = {};
  const percent = value => Math.max(0, Math.min(100, Math.round(Number(value))));

  function componentTransfer(input, result, count, linear) {
    // Quantize the browser's 8-bit intermediate values explicitly. This
    // avoids losing one level at exact cube/ramp colors through truncation.
    const values = Array.from({ length: 256 }, (_, value) => {
      let level = 0;
      while (level + 1 < count && value >= Math.floor((level + 1) * 255 / count)) level++;
      return Math.min(1, (Math.round(level * 255 / (count - 1)) + 0.5) / 255);
    }).join(' ');
    const rgb = ['R', 'G', 'B'].map(c => linear
      ? `<feFunc${c} type="linear" slope="${(count - 1) / count}"/>`
      : `<feFunc${c} type="discrete" tableValues="${values}"/>`).join('');
    return `<feComponentTransfer in="${input}" result="${result}">${rgb}</feComponentTransfer>`;
  }
  function quantize(count) {
    return componentTransfer('scene', `scaled${count}`, count, true) +
      `<feComposite in="scaled${count}" in2="pattern" operator="arithmetic" k2="1" k3="${15 / (16 * count)}" result="noisy${count}"/>` +
      componentTransfer(`noisy${count}`, `quant${count}`, count, false);
  }
  function mask(name, row, input = 'scene') {
    return `<feColorMatrix in="${input}" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${row.join(' ')}" result="${name}Raw"/>` +
      `<feComponentTransfer in="${name}Raw" result="${name}"><feFuncA type="discrete" tableValues="0 1"/></feComponentTransfer>`;
  }
  function axis() {
    const lowOffset = 0.5 + 128 * 17 / 255;
    const channels = '<feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/>';
    return '<feColorMatrix in="scene" values="128 -128 -128 0 .5  -128 128 -128 0 .5  -128 -128 128 0 .5  0 0 0 1 0" result="dominantRaw"/>' +
      `<feComponentTransfer in="dominantRaw" result="dominant">${channels}</feComponentTransfer>` +
      `<feColorMatrix in="scene" values="0 -128 -128 0 ${lowOffset}  -128 0 -128 0 ${lowOffset}  -128 -128 0 0 ${lowOffset}  0 0 0 1 0" result="lowRaw"/>` +
      `<feComponentTransfer in="lowRaw" result="low">${channels}</feComponentTransfer>` +
      '<feComposite in="dominant" in2="low" operator="arithmetic" k1="1" result="axisMasks"/>' +
      '<feColorMatrix in="axisMasks" values="1 -1 -1 0 0  0 1 -1 0 0  0 0 1 0 0  1 1 1 0 0" result="axisPriority"/>' +
      '<feComposite in="quant16" in2="axisPriority" operator="arithmetic" k1="1" result="axes"/>';
  }
  function gray() {
    return '<feColorMatrix in="scene" values="0 1 0 0 0  0 0 1 0 0  1 0 0 0 0  0 0 0 1 0" result="rotatedChannels"/>' +
      '<feBlend in="scene" in2="rotatedChannels" mode="difference" result="channelDifferences"/>' +
      mask('grayMask', [-128,-128,-128,0,0.5], 'channelDifferences') +
      '<feComposite in="quant16" in2="grayMask" operator="in" result="gray"/>';
  }
  function vignetteValue() {
    const saved = currentScreen && (vignettes[currentScreen.image] || VIGNETTE_DEFAULTS[currentScreen.image]);
    return saved || { strength: currentScreen?.noVignette ? 0 : 75, size: 50 };
  }
  function getValue(name) {
    if (name === 'mix') return Math.round(mix * 100);
    if (name === 'noise') return Math.round(noise * 100);
    if (name === 'crt') return Math.round(crt * 100);
    if (name === 'bloom') return Math.round(bloom * 100);
    return vignetteValue()[name === 'vignette' ? 'strength' : 'size'];
  }
  function saveVignettes() {
    try { localStorage.setItem(VIGNETTE_STORE, JSON.stringify(vignettes)); } catch (_) {}
  }
  function applyVignette() {
    if (!currentScreen) return;
    const value = vignetteValue(), factor = 0.25 + value.size * 0.015;
    stage.style.setProperty('--vignette-alpha', String(value.strength / 100));
    stage.style.setProperty('--vignette-grain-alpha', String(value.strength / 100 * (0.35 / 0.75)));
    stage.style.setProperty('--vignette-blur', (18 * factor) + 'vw');
    stage.style.setProperty('--vignette-spread', (4 * factor) + 'vw');
    stage.style.setProperty('--vignette-midstop', (70 - value.size * 0.6) + '%');
    for (const id of ['vignette', 'grain']) document.getElementById(id).style.display = value.strength === 0 ? 'none' : '';
  }
  function syncControls() {
    if (!controls) return;
    enabledInput.checked = enabled;
    for (const [name, fields] of Object.entries(inputs)) {
      const value = getValue(name);
      fields.slider.value = String(value);
      fields.slider.setAttribute('aria-valuetext', value + '%');
      if (document.activeElement !== fields.number) fields.number.value = String(value);
      fields.slider.disabled = fields.number.disabled = name in settings ? !enabled : !currentScreen;
    }
    controls.querySelector('#vignette-screen-name').textContent = currentScreen
      ? currentScreen.title + ' · ' + decodeURIComponent(currentScreen.image).replace(/^renders\//, '')
      : 'Войди в игру, чтобы настроить текущий кадр';
    controls.querySelector('#vignette-reset').disabled = !currentScreen;
  }
  function setAmount(name, value, persist = false) {
    if (!Number.isFinite(Number(value))) return;
    const amount = percent(value);
    if (name === 'mix') {
      mix = amount / 100;
      updateFilter();
    } else if (name === 'noise') {
      noise = amount / 100;
      syncNoise();
    } else if (name === 'crt') {
      crt = amount / 100;
      scanlineLayer.style.opacity = String(crt);
      scanlineLayer.hidden = !enabled || crt === 0;
    } else if (name === 'bloom') {
      bloom = amount / 100;
      updateFilter();
    } else if (currentScreen) {
      vignettes[currentScreen.image] = { ...vignetteValue(), [name === 'vignette' ? 'strength' : 'size']: amount };
      applyVignette();
      if (persist) saveVignettes();
    }
    if (persist && settings[name]) {
      try { localStorage.setItem(settings[name].store, String(amount)); } catch (_) {}
    }
    syncControls();
  }
  function syncNoise() {
    const active = enabled && noise > 0 && !document.hidden;
    noiseLayer.hidden = !active;
    noiseLayer.style.opacity = String(noise);
    noiseTexture.style.animationPlayState = active ? 'running' : 'paused';
  }
  function updateFilter() {
    const nextKey = `${mix > 0}:${bloom > 0}`;
    if (pipelineKey !== nextKey) {
      pipelineKey = nextKey;
      let processed = 'scene';
      let primitives = '<feFlood flood-color="#000" result="black"/>' +
        '<feComposite in="SourceGraphic" in2="black" operator="over" result="scene"/>';
      if (mix > 0) {
        primitives += `<feImage href="${NOISE}" x="0" y="0" width="4" height="4" preserveAspectRatio="none" image-rendering="pixelated" result="patternCell"/>` +
          '<feTile in="patternCell" result="pattern"/>' + quantize(6) + quantize(16) + axis() + gray() +
          mask('blackMask', [-256,-256,-256,0,0.5]) +
          '<feComposite in="black" in2="blackMask" operator="in" result="exactBlack"/>' +
          '<feMerge result="dithered"><feMergeNode in="quant6"/><feMergeNode in="axes"/><feMergeNode in="gray"/><feMergeNode in="exactBlack"/></feMerge>' +
          '<feComposite id="game-dither-mix" in="dithered" in2="scene" operator="arithmetic" k2="1" k3="0" result="mixed"/>';
        processed = 'mixed';
      }
      if (bloom > 0) {
        primitives += `<feColorMatrix in="${processed}" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0.8504 2.8608 0.2888 0 -1.8" result="bloomHighlights"/>` +
          '<feGaussianBlur id="game-screen-bloom-blur" in="bloomHighlights" stdDeviation="2.2" result="bloomGlow"/>' +
          `<feBlend in="bloomGlow" in2="${processed}" mode="screen" result="withBloom"/>` +
          `<feComposite id="game-screen-bloom-mix" in="withBloom" in2="${processed}" operator="arithmetic" k2="0" k3="1"/>`;
      }
      filter.innerHTML = primitives;
      mixNode = filter.querySelector('#game-dither-mix');
      bloomMixNode = filter.querySelector('#game-screen-bloom-mix');
      bloomBlurNode = filter.querySelector('#game-screen-bloom-blur');
    }
    if (mixNode) { mixNode.setAttribute('k2', String(mix)); mixNode.setAttribute('k3', String(1 - mix)); }
    if (bloomMixNode) { bloomMixNode.setAttribute('k2', String(bloom)); bloomMixNode.setAttribute('k3', String(1 - bloom)); }
    if (bloomBlurNode) bloomBlurNode.setAttribute('stdDeviation', String(2.2 * stage.clientWidth / 640));
    stage.classList.toggle('game-dither-enabled', enabled && (mix > 0 || bloom > 0));
  }
  function setEnabled(next, announce = false) {
    enabled = !!next;
    updateFilter();
    scanlineLayer.hidden = !enabled || crt === 0;
    syncControls(); syncNoise();
    if (!announce) return;
    try { localStorage.setItem(STORE, enabled ? '1' : '0'); } catch (_) {}
    toast.textContent = `эффекты экрана: ${enabled ? 'вкл' : 'выкл'} · F8`;
    toast.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }
  function setControlsOpen(open) {
    controls.hidden = !open;
    if (open) (enabled ? inputs.mix.slider : enabledInput).focus();
  }
  function rangeRow(name, config) {
    return `<label for="game-dither-${name}-slider">${config.label}</label>` +
      `<div class="dither-mix-row"><input type="range" id="game-dither-${name}-slider" min="0" max="100" step="1" aria-label="${config.aria}">` +
      `<input type="number" id="game-dither-${name}-number" min="0" max="100" step="1" aria-label="${config.aria} в процентах"><span>%</span></div>`;
  }
  function buildControls() {
    controls = document.createElement('section'); controls.id = 'game-dither-controls'; controls.hidden = true;
    controls.setAttribute('aria-labelledby', 'game-dither-heading');
    controls.innerHTML = '<div class="dither-controls-heading"><h2 id="game-dither-heading">эффекты экрана</h2>' +
      '<button type="button" id="game-dither-close" aria-label="Закрыть настройки эффектов">×</button></div>' +
      '<label class="dither-enabled"><input type="checkbox" id="game-dither-enabled-input"> дизеринг, шум, CRT и блум</label>' +
      Object.entries(settings).map(([name, config]) => rangeRow(name, config)).join('') +
      '<div class="vignette-controls"><h3>виньетка этого кадра</h3><p id="vignette-screen-name" aria-live="polite"></p>' +
      Object.entries(vignetteFields).map(([name, config]) => rangeRow(name, config)).join('') +
      '<div class="vignette-actions"><button type="button" id="vignette-reset">сбросить кадр</button>' +
      '<button type="button" id="vignette-export">выгрузить JSON</button></div></div>' +
      '<p>Shift+F8 — настройки · F8 — вкл/выкл</p>';
    document.body.appendChild(controls);
    enabledInput = controls.querySelector('#game-dither-enabled-input');
    enabledInput.addEventListener('change', () => setEnabled(enabledInput.checked, true));
    for (const name of Object.keys({ ...settings, ...vignetteFields })) {
      const slider = controls.querySelector(`#game-dither-${name}-slider`);
      const number = controls.querySelector(`#game-dither-${name}-number`);
      inputs[name] = { slider, number };
      slider.addEventListener('input', () => setAmount(name, slider.value, true));
      number.addEventListener('input', () => { if (number.value !== '') setAmount(name, number.value, true); });
      const commit = () => { setAmount(name, number.value === '' ? getValue(name) : number.value, true); number.value = String(getValue(name)); };
      number.addEventListener('change', commit); number.addEventListener('blur', commit);
      number.addEventListener('keydown', e => { if (e.key === 'Enter') number.blur(); });
    }
    controls.querySelector('#vignette-reset').addEventListener('click', () => {
      if (!currentScreen) return;
      delete vignettes[currentScreen.image]; saveVignettes(); applyVignette(); syncControls();
    });
    controls.querySelector('#vignette-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ version: 1, vignettes: { ...VIGNETTE_DEFAULTS, ...vignettes } }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'untorra-vignette.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    controls.querySelector('#game-dither-close').addEventListener('click', () => setControlsOpen(false));
    controls.addEventListener('keydown', e => { if (e.code !== 'F8') e.stopPropagation(); });
  }
  function init() {
    stage = document.getElementById('stage'); if (!stage) return;
    const game = document.getElementById('game');
    const fade = document.getElementById('fade-overlay');
    if (fade) game.appendChild(fade);
    noiseLayer = document.createElement('div'); noiseLayer.id = 'game-screen-noise-layer';
    noiseLayer.setAttribute('aria-hidden', 'true'); noiseLayer.hidden = true;
    noiseTexture = document.createElement('div'); noiseTexture.className = 'game-screen-noise-texture';
    noiseLayer.appendChild(noiseTexture); game.appendChild(noiseLayer);
    scanlineLayer = document.createElement('div');
    scanlineLayer.id = 'game-crt-scanlines'; scanlineLayer.hidden = true;
    scanlineLayer.setAttribute('aria-hidden', 'true');
    game.appendChild(scanlineLayer);
    const svg = document.createElementNS(NS, 'svg'); svg.id = 'game-dither-defs';
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden';
    const defs = document.createElementNS(NS, 'defs'); filter = document.createElementNS(NS, 'filter');
    filter.id = 'game-dither-filter';
    filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB'); filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
    defs.appendChild(filter); svg.appendChild(defs); document.body.appendChild(svg);
    toast = document.createElement('div'); toast.id = 'game-dither-toast'; toast.setAttribute('role', 'status'); document.body.appendChild(toast);
    try {
      const saved = JSON.parse(localStorage.getItem(VIGNETTE_STORE) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [key, value] of Object.entries(saved)) {
          if (value && Number.isFinite(value.strength) && Number.isFinite(value.size)) vignettes[key] = { strength: percent(value.strength), size: percent(value.size) };
        }
      }
    } catch (_) {}
    buildControls();
    document.addEventListener('untorra:screenchange', event => {
      currentScreen = event.detail;
      applyVignette(); syncControls();
      for (const name of Object.keys(vignetteFields)) inputs[name].number.value = String(getValue(name));
    });
    const resize = () => {
      const bounds = stage.getBoundingClientRect();
      filter.setAttribute('width', String(bounds.width)); filter.setAttribute('height', String(bounds.height));
      if (bloomBlurNode) bloomBlurNode.setAttribute('stdDeviation', String(2.2 * bounds.width / 640));
    };
    resize(); new ResizeObserver(resize).observe(stage);
    document.addEventListener('visibilitychange', syncNoise);
    const forced = new URLSearchParams(location.search).get('dither');
    if (forced === '0' || forced === '1') enabled = forced === '1';
    else { try { const saved = localStorage.getItem(STORE); if (saved !== null) enabled = saved === '1'; } catch (_) {} }
    for (const [name, config] of Object.entries(settings)) {
      let value = getValue(name);
      try { const saved = localStorage.getItem(config.store); if (saved !== null) value = saved; } catch (_) {}
      setAmount(name, value);
    }
    setEnabled(enabled);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !controls.hidden) { e.preventDefault(); e.stopImmediatePropagation(); setControlsOpen(false); return; }
      if (e.code !== 'F8' || e.repeat) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey) setControlsOpen(controls.hidden); else setEnabled(!enabled, true);
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
