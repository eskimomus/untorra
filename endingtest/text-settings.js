const STORAGE_KEY = 'untorra-ending-text-settings-v3';
const CHANGE_EVENT = 'untorra:textsettings';
const GROUPS = ['Печать', 'Основная расшифровка', 'Побочные строки', 'Появление и оформление'];

export const TEXT_SETTING_FIELDS = Object.freeze([
  { key: 'letterDelay', group: 0, label: 'Задержка между буквами', value: 20, max: 500, min: 10 },
  { key: 'letterJitter', group: 0, label: 'Случайная добавка к задержке', value: 100, max: 1000 },
  { key: 'wordPause', group: 0, label: 'Пауза между словами', value: 329, max: 4000 },
  { key: 'wordPauseJitter', group: 0, label: 'Случайная добавка между словами', value: 160, max: 2000 },
  { key: 'hesitationChance', group: 0, label: 'Вероятность заминки', value: 15, max: 100, unit: '%' },
  { key: 'hesitationPause', group: 0, label: 'Длительность заминки', value: 70, max: 2000 },
  { key: 'hesitationJitter', group: 0, label: 'Случайная добавка к заминке', value: 140, max: 2000 },
  { key: 'punctuationPause', group: 0, label: 'Пауза после знаков препинания', value: 120, max: 4000 },
  { key: 'punctuationJitter', group: 0, label: 'Случайная добавка после знаков', value: 170, max: 2000 },
  { key: 'atomicPause', group: 0, label: 'Пауза после цельного слова UNTORRA', value: 520, max: 4000 },
  { key: 'decodeLag', group: 1, label: 'Отставание перевода от печати', value: 436, max: 5000 },
  { key: 'decodeStep', group: 1, label: 'Пауза между раскрытиями букв', value: 45, max: 2000 },
  { key: 'decodeJitter', group: 1, label: 'Случайная добавка к раскрытию', value: 35, max: 2000 },
  { key: 'decodeFlicker', group: 1, label: 'Длительность смены символа (×2)', value: 61, max: 500 },
  { key: 'untorraLetterInterval', group: 1, label: 'UNTORRA — ровный интервал между буквами', value: 250, min: 50, max: 2000 },
  { key: 'decodeSettle', group: 1, label: 'Пауза после полного перевода', value: 160, max: 5000 },
  { key: 'echoDelay', group: 2, label: 'Ожидание до расшифровки', value: 502, max: 10000 },
  { key: 'echoDelayJitter', group: 2, label: 'Случайная добавка к ожиданию', value: 1200, max: 10000 },
  { key: 'echoStep', group: 2, label: 'Пауза между случайными буквами', value: 350, max: 5000 },
  { key: 'echoJitter', group: 2, label: 'Случайная добавка между буквами', value: 700, max: 5000 },
  { key: 'echoFlicker', group: 2, label: 'Длительность смены символа', value: 80, max: 1000 },
  { key: 'echoShake', group: 2, label: 'Амплитуда тряски', value: 1, max: 6, unit: 'px' },
  { key: 'echoMotion', group: 2, label: 'Длительность цикла тряски', value: 1000, min: 100, max: 6000 },
  { key: 'startPause', group: 3, label: 'Пауза перед началом печати', value: 180, max: 5000 },
  { key: 'revealFade', group: 3, label: 'Появление строк и интерфейса', value: 700, max: 5000 },
  { key: 'echoStagger', group: 3, label: 'Интервал появления групп эха', value: 180, max: 5000 },
  { key: 'alienColor', group: 3, label: 'Цвет текста и инопланетных символов', value: '#ed974e', kind: 'color' },
].map(field => Object.freeze({ min: 0, step: 1, unit: 'мс', ...field })));

export const DEFAULT_TEXT_SETTINGS = Object.freeze(Object.fromEntries(TEXT_SETTING_FIELDS.map(field => [field.key, field.value])));

export function normalizeTextSettings(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.freeze(Object.fromEntries(TEXT_SETTING_FIELDS.map(field => {
    const value = source[field.key];
    if (field.kind === 'color') return [field.key, typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : field.value];
    return [field.key, typeof value === 'number' && Number.isFinite(value)
      ? Math.round(Math.max(field.min, Math.min(field.max, value))) : field.value];
  })));
}

export function parseTextSettings(json) {
  const data = JSON.parse(json);
  if (data?.format !== 'untorra-text-settings' || data.version !== 1 || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
    throw new Error('Нужен JSON настроек текста UNTORRA версии 1.');
  }
  for (const field of TEXT_SETTING_FIELDS) {
    if (!Object.hasOwn(data.settings, field.key)) continue;
    const value = data.settings[field.key];
    if (field.kind === 'color' ? typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value) : typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Некорректное значение: ${field.label}.`);
    }
  }
  return normalizeTextSettings(data.settings);
}

export function serializeTextSettings(settings) {
  return JSON.stringify({ format: 'untorra-text-settings', version: 1, settings: normalizeTextSettings(settings) }, null, 2) + '\n';
}

function browserStorage() {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readTextSettings(storage) {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return saved ? parseTextSettings(saved) : DEFAULT_TEXT_SETTINGS;
  } catch { return DEFAULT_TEXT_SETTINGS; }
}

export function saveTextSettings(storage, settings) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, serializeTextSettings(settings));
    return true;
  } catch { return false; }
}

let currentSettings = readTextSettings(browserStorage());
export function getTextSettings() { return currentSettings; }

export function updateTextSettings(patch) {
  currentSettings = normalizeTextSettings({ ...currentSettings, ...patch });
  const saved = saveTextSettings(browserStorage(), currentSettings);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  return { settings: currentSettings, saved };
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  currentSettings = readTextSettings(browserStorage());
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
});

export function mountTextSettings(tools, { enabled, onReplay }) {
  if (!enabled) return;
  const panel = document.createElement('details');
  panel.id = 'text-settings';
  const summary = document.createElement('summary');
  summary.textContent = 'ТЕКСТ И РАСШИФРОВКА · F7';
  panel.appendChild(summary);
  const hint = document.createElement('p');
  hint.className = 'text-settings-hint';
  hint.textContent = 'Больше задержка — медленнее. Случайная добавка: от 0 до указанного значения. Изменения сохраняются автоматически; применяются со следующей сцены или кнопкой «Применить и повторить». В режиме уменьшенного движения часть эффектов отключена.';
  panel.appendChild(hint);
  const inputs = new Map();
  for (const [groupIndex, title] of GROUPS.entries()) {
    const group = document.createElement('details');
    group.className = 'text-settings-group';
    group.open = groupIndex === 0;
    const heading = document.createElement('summary');
    heading.textContent = title;
    group.appendChild(heading);
    for (const field of TEXT_SETTING_FIELDS.filter(candidate => candidate.group === groupIndex)) {
      const row = document.createElement('div');
      row.className = 'text-setting';
      const label = document.createElement('label');
      label.htmlFor = `text-setting-${field.key}`;
      label.textContent = field.label;
      row.appendChild(label);
      const controls = document.createElement('div');
      controls.className = 'text-setting-controls';
      const primary = document.createElement('input');
      primary.id = label.htmlFor;
      primary.type = field.kind === 'color' ? 'color' : 'range';
      primary.dataset.setting = field.key;
      const precise = document.createElement('input');
      precise.type = field.kind === 'color' ? 'text' : 'number';
      precise.setAttribute('aria-label', field.label + ' — точное значение');
      if (field.kind !== 'color') {
        for (const input of [primary, precise]) {
          input.min = field.min;
          input.max = field.max;
          input.step = field.step;
        }
      } else {
        precise.maxLength = 7;
        precise.pattern = '#[0-9a-fA-F]{6}';
      }
      const unit = document.createElement('span');
      unit.textContent = field.kind === 'color' ? '' : field.unit;
      controls.append(primary, precise, unit);
      inputs.set(field.key, [primary, precise]);
      const commit = input => {
        if (input.value === '' || !input.validity.valid) return;
        const value = field.kind === 'color' ? input.value : Number(input.value);
        if (field.kind === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) return;
        const { saved } = updateTextSettings({ [field.key]: value });
        report(saved ? 'Сохранено. Примени настройки, чтобы повторить текущую сцену.' : 'Настройки действуют в этой вкладке: браузер запретил сохранение.');
      };
      primary.addEventListener('input', () => commit(primary));
      precise.addEventListener('input', () => commit(precise));
      precise.addEventListener('blur', () => { precise.value = getTextSettings()[field.key]; });
      row.appendChild(controls);
      group.appendChild(row);
    }
    panel.appendChild(group);
  }
  const actions = document.createElement('div');
  actions.className = 'tools-buttons text-settings-actions';
  const button = (title, action) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = title;
    element.addEventListener('click', action);
    actions.appendChild(element);
    return element;
  };
  const replay = button('Применить и повторить', () => {
    if (onReplay() === false) { report('Подожди, пока загрузятся ассеты.'); return; }
    tools.open = false;
  });
  replay.id = 'text-settings-apply';
  button('Сбросить', () => {
    const { saved } = updateTextSettings(DEFAULT_TEXT_SETTINGS);
    report(saved ? 'Возвращены исходные настройки. Нажми «Применить и повторить».' : 'Возвращены исходные настройки только для этой вкладки.');
  }).id = 'text-settings-reset';
  button('Экспорт JSON', () => {
    const url = URL.createObjectURL(new Blob([serializeTextSettings(getTextSettings())], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'untorra-text-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report('JSON содержит только настройки текста. Его можно прислать, чтобы сделать их настройками по умолчанию.');
  }).id = 'text-settings-export';
  const file = document.createElement('input');
  file.id = 'text-settings-import';
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  button('Импорт JSON', () => file.click());
  file.addEventListener('change', async () => {
    try {
      const selected = file.files[0];
      if (!selected) return;
      if (selected.size > 65536) throw new Error('Файл настроек слишком большой (максимум 64 КБ).');
      const settings = parseTextSettings(await selected.text());
      const { saved } = updateTextSettings(settings);
      report(saved ? 'Настройки импортированы и сохранены. Нажми «Применить и повторить».' : 'Настройки импортированы только для этой вкладки.');
    } catch (error) { report(error.message); }
    finally { file.value = ''; }
  });
  const status = document.createElement('output');
  status.id = 'text-settings-status';
  status.setAttribute('aria-live', 'polite');
  const report = message => { status.textContent = message; };
  panel.append(actions, file, status);
  tools.querySelector('.tools-body').prepend(panel);
  const syncInputs = () => {
    for (const [key, controls] of inputs) for (const input of controls) input.value = getTextSettings()[key];
  };
  syncInputs();
  window.addEventListener(CHANGE_EVENT, syncInputs);
  const expand = () => tools.classList.toggle('text-settings-expanded', tools.open && panel.open);
  panel.addEventListener('toggle', event => { if (event.target === panel) expand(); });
  tools.addEventListener('toggle', expand);
  const open = () => { tools.open = true; panel.open = true; expand(); tools.querySelector('.tools-body').scrollTop = 0; };
  document.addEventListener('keydown', event => {
    if (event.code !== 'F7' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (tools.open && panel.open) tools.open = false;
    else open();
  });
  if (new URLSearchParams(location.search).get('textSettings') === '1') open();
}
