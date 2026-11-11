import { DEFAULT_TEXT_SETTINGS, getTextSettings } from './text-settings.js?v=3';

export const ALIEN_TEXT_TIMING = Object.freeze({ hold: DEFAULT_TEXT_SETTINGS.decodeLag, settle: DEFAULT_TEXT_SETTINGS.decodeSettle });

export function cipherGlyph(text, index, revision = 0) {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  hash = Math.imul(hash ^ index, 2246822519);
  hash = Math.imul(hash ^ revision, 3266489917);
  return String.fromCharCode(97 + ((hash ^ (hash >>> 16)) >>> 0) % 26);
}

export function alienWords(text, glyphs, size) {
  return Array.from(text.matchAll(/\S+/gu), match => {
    const start = match.index;
    const end = start + match[0].length;
    const letters = glyphs.filter(glyph => glyph.end > start && glyph.end <= end);
    const first = letters[0];
    const last = letters.at(-1);
    return {
      start, end, glyphs: letters, size,
      left: first?.horizontal ?? 0,
      width: first ? last.horizontal + last.advance - first.horizontal : 0,
      baseline: first?.vertical ?? 0,
    };
  });
}

export function translationFrames(text, { atomicWords = [], random = Math.random, settings = getTextSettings() } = {}) {
  const words = Array.from(text.matchAll(/\S+/gu));
  if (!words.length) return [];
  const frames = [], decoded = [];
  let offset = 0, translated = 0;
  while (offset < text.length) {
    const atomic = atomicWords.find(word => text.slice(offset, offset + word.length).toUpperCase() === word.toUpperCase()
      && !/[\p{L}\p{N}]/u.test(text[offset - 1] || '')
      && !/[\p{L}\p{N}]/u.test(text[offset + word.length] || ''));
    const character = atomic || String.fromCodePoint(text.codePointAt(offset));
    const start = offset;
    offset += character.length;
    if (!/\S/u.test(character)) continue;
    const positions = Array.from(character.matchAll(/\S/gu), match => start + match.index + match[0].length);
    for (const [index, position] of positions.entries()) {
      const flicker = atomic ? Math.min(settings.decodeFlicker, settings.untorraLetterInterval / 3)
        : settings.decodeFlicker + random() * Math.min(15, settings.decodeFlicker);
      frames.push({ end: position, decoded: [...decoded], translated, flickering: position, revision: 1, duration: flicker });
      frames.push({ end: position, decoded: [...decoded], translated, flickering: position, revision: 2, duration: flicker });
      decoded.push(position);
      translated = words.filter(word => word.index + word[0].length <= position).length;
      frames.push({
        end: position, decoded: [...decoded], translated, flickering: null, revision: 0,
        duration: atomic ? settings.untorraLetterInterval - flicker * 2 : settings.decodeStep + random() * settings.decodeJitter,
        sound: atomic && index === positions.length - 1 ? 'untorra' : null,
        letterSound: atomic ? 'untorra-type' : null,
      });
    }
  }
  return frames;
}

export function concurrentTypingFrames(text, tokens, { atomicWords = [], voice = 'player', random = Math.random, settings = getTextSettings(), hold = settings.decodeLag } = {}) {
  let typingTime = 0;
  const typing = tokens.map(token => {
    const event = { at: typingTime, type: 'typing', token };
    typingTime += token.duration;
    return event;
  });
  const events = [...typing];
  const decoding = translationFrames(text, { atomicWords, random, settings });
  let translationTime = 0;
  for (let index = 0; index < decoding.length; index += 3) {
    const group = decoding.slice(index, index + 3);
    const typedIndex = typing.findIndex(event => event.token.end >= group[0].end);
    const completed = typing[typedIndex];
    if (!completed) continue;
    translationTime = Math.max(translationTime, completed.at + hold);
    for (const frame of group) {
      events.push({ at: translationTime, type: 'translation', frame });
      translationTime += frame.duration;
    }
    if (group.at(-1).sound === 'untorra' && typing[typedIndex + 1]) {
      const delay = Math.max(0, translationTime - typing[typedIndex + 1].at);
      for (let index = typedIndex + 1; index < typing.length; index++) typing[index].at += delay;
    }
  }
  events.sort((first, second) => first.at - second.at || Number(first.type === 'translation') - Number(second.type === 'translation'));
  const duration = Math.max((typing.at(-1)?.at ?? 0) + (tokens.at(-1)?.duration ?? 0), translationTime);
  let visible = 0, translated = 0, revision = 0, decoded = [], flickering = null;
  return events.map((event, index) => {
    let sound, letterSound;
    if (event.type === 'typing') {
      visible = event.token.end;
      sound = event.token.sound === 'untorra' ? voice : event.token.sound;
    } else {
      translated = event.frame.translated;
      revision = event.frame.revision;
      decoded = event.frame.decoded;
      flickering = event.frame.flickering;
      sound = event.frame.sound;
      letterSound = event.frame.letterSound;
    }
    return {
      at: event.at, type: event.type, visible, translated, decoded, flickering, revision, sound, letterSound,
      duration: Math.max(0, (events[index + 1]?.at ?? duration) - event.at),
    };
  });
}

export function echoTranslationFrames(text, { random = Math.random, settings = getTextSettings() } = {}) {
  const order = Array.from(text.matchAll(/\S/gu), match => match.index + match[0].length);
  if (!order.length) return [];
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  const frames = [{ decoded: [], flickering: null, revision: 0, duration: settings.echoDelay + random() * settings.echoDelayJitter }];
  const decoded = [];
  for (const [index, position] of order.entries()) {
    frames.push({ decoded: [...decoded], flickering: position, revision: 1, duration: settings.echoFlicker });
    frames.push({ decoded: [...decoded], flickering: position, revision: 2, duration: settings.echoFlicker * 0.875 });
    decoded.push(position);
    frames.push({
      decoded: [...decoded], flickering: null, revision: 0,
      duration: index === order.length - 1 ? 0 : settings.echoStep + random() * settings.echoJitter,
    });
  }
  return frames;
}

export function alienInkColor(color, settings = getTextSettings()) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  const digits = hex?.[1].length === 3 ? Array.from(hex[1], digit => digit + digit).join('') : hex?.[1];
  const values = digits
    ? [0, 2, 4].map(offset => parseInt(digits.slice(offset, offset + 2), 16))
    : (color.match(/[\d.]+/g) || ['255', '255', '255']).map(Number);
  if (values[0] > 0 && values[1] <= values[0] * 0.25 && values[2] <= values[0] * 0.25) return color;
  const brightness = Math.max(...values.slice(0, 3)) / 255 || 0.22;
  const channels = [1, 3, 5].map(offset => Math.round(parseInt(settings.alienColor.slice(offset, offset + 2), 16) * brightness));
  return values[3] === undefined || values[3] === 1
    ? `rgb(${channels.join(', ')})`
    : `rgba(${channels.join(', ')}, ${values[3]})`;
}

export class AlienGlyphAtlas {
  constructor(image, metrics) {
    this.image = image;
    this.metrics = metrics;
    this.tints = new Map();
    this.rasters = new Map();
  }

  imageForColor(color) {
    if (!this.tints.has(color)) {
      const canvas = document.createElement('canvas');
      canvas.width = this.image.naturalWidth;
      canvas.height = this.image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(this.image, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.tints.set(color, canvas);
    }
    return this.tints.get(color);
  }

  glyphRaster(image, glyph, color, width, height) {
    const key = [color, glyph.x, glyph.y, width, height].join(':');
    if (!this.rasters.has(key)) {
      let canvas = document.createElement('canvas');
      canvas.width = glyph.width;
      canvas.height = glyph.height;
      canvas.getContext('2d').drawImage(image, glyph.x, glyph.y, glyph.width, glyph.height, 0, 0, glyph.width, glyph.height);
      while (canvas.width > width || canvas.height > height) {
        const reduced = document.createElement('canvas');
        reduced.width = Math.max(width, Math.floor(canvas.width / 2));
        reduced.height = Math.max(height, Math.floor(canvas.height / 2));
        reduced.getContext('2d').drawImage(canvas, 0, 0, reduced.width, reduced.height);
        canvas = reduced;
      }
      if (this.rasters.size >= 512) this.rasters.delete(this.rasters.keys().next().value);
      this.rasters.set(key, canvas);
    }
    return this.rasters.get(key);
  }

  drawWord(context, text, word, { visible, revision = 0, offsetX = 0, decoded = null, flickering = null, settings = getTextSettings() }) {
    if (!word.glyphs.length) return;
    const color = alienInkColor(word.glyphs[0].color, settings);
    const image = this.imageForColor(color);
    const transform = context.getTransform?.();
    for (const source of word.glyphs) {
      if (source.end > visible || decoded?.has(source.end)) continue;
      const glyph = this.metrics.glyphs[cipherGlyph(text, source.end, !decoded || source.end === flickering ? revision : 0)];
      const ink = source.ink || { left: 0, width: source.advance, ascent: word.size * 0.75, descent: 0 };
      if (!(ink.width > 0 && ink.ascent + ink.descent > 0)) continue;
      const raster = transform ? this.glyphRaster(image, glyph, color,
        Math.max(1, Math.ceil(ink.width * Math.abs(transform.a))),
        Math.max(1, Math.ceil((ink.ascent + ink.descent) * Math.abs(transform.d))),
      ) : null;
      context.save();
      context.imageSmoothingQuality = 'high';
      context.translate(source.horizontal + ink.left + ink.width + offsetX, source.vertical + ink.descent);
      context.scale(-ink.width / glyph.width, -(ink.ascent + ink.descent) / glyph.height);
      if (raster) context.drawImage(raster, 0, 0, glyph.width, glyph.height);
      else context.drawImage(image, glyph.x, glyph.y, glyph.width, glyph.height, 0, 0, glyph.width, glyph.height);
      context.restore();
    }
  }
}

export async function loadAlienGlyphAtlas() {
  const image = new Image();
  image.src = new URL('./assets/fonts/lifeform-atlas.png', import.meta.url).href;
  const [response] = await Promise.all([
    fetch(new URL('./assets/fonts/lifeform-atlas.json?v=2', import.meta.url)),
    image.decode(),
  ]);
  if (!response.ok) throw new Error('Alien lettering unavailable');
  return new AlienGlyphAtlas(image, await response.json());
}
