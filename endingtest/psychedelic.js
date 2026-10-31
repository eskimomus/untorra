import { isTripScene } from './story.js?v=13';

const VERTEX_SOURCE = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT_SOURCE = `
precision mediump float;
uniform vec2 resolution;
uniform float elapsed;
uniform float mode;
uniform float reduced;
uniform float progress;
uniform sampler2D portrait;

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 spectrum(float phase) {
  return 0.5 + 0.5 * cos(6.283185 * (phase + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 coordinates = gl_FragCoord.xy / resolution;
  vec2 point = (2.0 * gl_FragCoord.xy - resolution) / resolution.y;
  float frame = floor(elapsed * 22.0);
  if (mode > 0.5) {
    float violence = mode < 1.5 ? smoothstep(0.04, 0.65, progress) : 1.0;
    float slice = floor(coordinates.y * 37.0);
    float tear = step(0.52, hash(vec2(slice, frame)));
    float displacement = (hash(vec2(frame, slice)) - 0.5) * tear * 0.58 * violence;
    vec2 designPoint = vec2(coordinates.x + displacement, 1.0 - coordinates.y) * vec2(640.0, 480.0);
    vec2 facePoint = (designPoint - vec2(109.0, 51.0)) / vec2(421.0, 377.0);
    vec3 face = vec3(0.0);
    if (mode < 1.5 && facePoint.x > 0.0 && facePoint.y > 0.0 && facePoint.x < 1.0 && facePoint.y < 1.0) {
      face = texture2D(portrait, vec2(facePoint.x, 1.0 - facePoint.y)).rgb;
      face.g = texture2D(portrait, vec2(facePoint.x + tear * 0.075 * violence, 1.0 - facePoint.y)).g;
      face.b = texture2D(portrait, vec2(facePoint.x - tear * 0.065 * violence, 1.0 - facePoint.y)).b;
    }
    vec3 color = max(vec3(1.0, 0.0, 0.0), face);
    float darkBand = step(0.82, hash(vec2(slice + 11.0, frame)));
    color *= 1.0 - darkBand * 0.94 * violence;
    color += spectrum(hash(vec2(slice, frame))) * step(0.94, hash(vec2(slice + 4.0, frame))) * 0.8 * violence;
    if (mode < 1.5) color *= 1.0 - smoothstep(0.88, 1.0, progress) * 0.8;
    gl_FragColor = vec4(color, 1.0);
    return;
  }

  float intensity = (0.3 + smoothstep(0.0, 0.9, progress) * 0.7) * mix(1.0, 0.22, reduced);
  float time = elapsed * mix(0.9 + progress * 0.6, 0.13, reduced);
  float stripe = floor(coordinates.y * 46.0);
  float tearing = (hash(vec2(stripe, floor(time * 9.0))) - 0.5) * step(0.92 - intensity * 0.17, hash(vec2(stripe + 1.0, floor(time * 9.0))));
  point.x += tearing * 0.8 * intensity;
  point.y += sin(point.x * 6.0 + time * 0.8) * 0.08 * intensity;
  float radius = length(point);
  float angle = atan(point.y, point.x) + time * 0.12 + sin(radius * 4.0 - time) * intensity * 0.4;
  float sectors = mix(6.0, 16.0, smoothstep(0.1, 0.85, progress));
  float sectorAngle = abs(mod(angle + 3.141593 / sectors, 6.283185 / sectors) - 3.141593 / sectors);
  float zoom = 1.0 + sin(time * 0.8) * 0.22 * intensity;
  vec2 folded = radius * vec2(cos(sectorAngle), sin(sectorAngle)) * zoom;
  float rotation = time * 0.23;
  mat2 rotate = mat2(cos(rotation), -sin(rotation), sin(rotation), cos(rotation));
  float web = 0.0;
  for (int iteration = 0; iteration < 5; iteration++) {
    folded = abs(rotate * folded) / max(dot(folded, folded), 0.16) - vec2(0.72 + sin(time * 0.19) * 0.12, 0.61);
    web += sin(folded.x * 4.2 + time) * cos(folded.y * 3.7 - time * 0.6) / 5.0;
  }
  float tunnel = sin(16.0 * log(max(radius, 0.025)) - time * 4.2 + sin(sectorAngle * sectors * 2.0 + time) * 2.5);
  float petals = sin(sectorAngle * sectors * 3.0 + radius * 19.0 - time * 2.0);
  float echo = sin(radius * 29.0 - time * 3.7 + web * 8.0);
  float phase = web * 0.7 + tunnel * 0.22 + petals * 0.16 + echo * intensity * 0.12 + time * 0.09;
  float separation = tearing * intensity * 0.24;
  vec3 color = 0.5 + 0.5 * cos(6.283185 * (phase + vec3(separation, 0.33, 0.67 - separation)));
  color = pow(color, vec3(0.5));
  float veins = pow(1.0 - abs(sin(web * 16.0 + radius * 15.0 - time * 1.5)), 7.0);
  color = mix(color * 0.46, vec3(1.0, 0.87, 0.99), veins * 0.92);
  color += spectrum(angle / 6.283185 + time * 0.13) * pow(1.0 - abs(echo), 9.0) * intensity * 0.65;
  float pupil = mix(0.49, 0.07, intensity);
  color *= smoothstep(pupil, pupil + 0.18, radius);
  float block = step(0.91, hash(vec2(floor(coordinates.y * 19.0), floor(time * 4.0))));
  color = mix(color, color.brg, block * intensity);
  float grain = hash(gl_FragCoord.xy + vec2(floor(time * 30.0), 0.0)) - 0.5;
  color += grain * 0.12;
  color = floor(clamp(color, 0.0, 1.0) * 10.0 + 0.5) / 10.0;
  color = mix(color, vec3(1.0), (1.0 - smoothstep(0.04, 0.18, coordinates.y)) * 0.8);
  float arrival = smoothstep(0.0, 1.7, elapsed);
  gl_FragColor = vec4(mix(vec3(1.0), color, arrival), 1.0);
}
`;

export class PsychedelicRenderer {
  constructor(canvas, portrait) {
    this.canvas = canvas;
    this.portrait = portrait;
    this.mode = null;
    this.active = false;
    this.reduced = false;
    this.frame = null;
    this.lastDraw = 0;
    this.started = 0;
    this.suspendedAt = null;
    this.draw = this.draw.bind(this);
    try {
      this.initWebGL();
      this.canvas.dataset.renderer = 'webgl';
    } catch (error) {
      const fallback = canvas.cloneNode();
      canvas.replaceWith(fallback);
      this.canvas = fallback;
      this.context = fallback.getContext('2d', { alpha: false });
      this.canvas.dataset.renderer = 'canvas2d';
    }
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.contextLost = true;
      this.suspend();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.initWebGL();
      this.contextLost = false;
      this.resume();
    });
  }

  initWebGL() {
    const graphics = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!graphics) throw new Error('WebGL is unavailable');
    const shader = (type, source) => {
      const compiled = graphics.createShader(type);
      graphics.shaderSource(compiled, source);
      graphics.compileShader(compiled);
      if (!graphics.getShaderParameter(compiled, graphics.COMPILE_STATUS)) throw new Error(graphics.getShaderInfoLog(compiled));
      return compiled;
    };
    const program = graphics.createProgram();
    const vertex = shader(graphics.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = shader(graphics.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    graphics.attachShader(program, vertex);
    graphics.attachShader(program, fragment);
    graphics.linkProgram(program);
    if (!graphics.getProgramParameter(program, graphics.LINK_STATUS)) throw new Error(graphics.getProgramInfoLog(program));
    graphics.deleteShader(vertex);
    graphics.deleteShader(fragment);
    graphics.useProgram(program);
    const buffer = graphics.createBuffer();
    graphics.bindBuffer(graphics.ARRAY_BUFFER, buffer);
    graphics.bufferData(graphics.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), graphics.STATIC_DRAW);
    const position = graphics.getAttribLocation(program, 'position');
    graphics.enableVertexAttribArray(position);
    graphics.vertexAttribPointer(position, 2, graphics.FLOAT, false, 0, 0);
    const texture = graphics.createTexture();
    graphics.bindTexture(graphics.TEXTURE_2D, texture);
    graphics.pixelStorei(graphics.UNPACK_FLIP_Y_WEBGL, true);
    graphics.texImage2D(graphics.TEXTURE_2D, 0, graphics.RGBA, graphics.RGBA, graphics.UNSIGNED_BYTE, this.portrait);
    graphics.texParameteri(graphics.TEXTURE_2D, graphics.TEXTURE_MIN_FILTER, graphics.LINEAR);
    graphics.texParameteri(graphics.TEXTURE_2D, graphics.TEXTURE_MAG_FILTER, graphics.LINEAR);
    graphics.texParameteri(graphics.TEXTURE_2D, graphics.TEXTURE_WRAP_S, graphics.CLAMP_TO_EDGE);
    graphics.texParameteri(graphics.TEXTURE_2D, graphics.TEXTURE_WRAP_T, graphics.CLAMP_TO_EDGE);
    this.uniforms = Object.fromEntries(['resolution', 'elapsed', 'mode', 'reduced', 'progress', 'portrait'].map(name => [name, graphics.getUniformLocation(program, name)]));
    graphics.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
    graphics.uniform1i(this.uniforms.portrait, 0);
    graphics.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.graphics = graphics;
  }

  setScene(scene, reduced, duration) {
    this.stop();
    this.mode = isTripScene(scene) ? 'trip' : scene === '3a' ? 'old-death' : ['13a', '3c'].includes(scene) ? 'death' : null;
    this.reduced = reduced;
    this.duration = Number.isFinite(duration) ? Math.max(1, duration) : 35000;
    this.canvas.hidden = !this.mode || (reduced && this.mode !== 'trip');
    this.canvas.dataset.mode = this.mode ?? 'off';
    this.canvas.dataset.phase = 'arriving';
    if (this.canvas.hidden) return;
    this.active = true;
    this.canvas.dataset.state = 'running';
    this.started = performance.now();
    this.lastDraw = -Infinity;
    this.draw(this.started);
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.active = false;
    this.canvas.dataset.state = 'stopped';
    this.suspendedAt = null;
  }

  suspend() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.active && this.suspendedAt === null) this.suspendedAt = performance.now();
    if (this.active) this.canvas.dataset.state = 'paused';
  }

  resume() {
    if (!this.active || this.contextLost || document.hidden) return;
    if (this.suspendedAt !== null) this.started += performance.now() - this.suspendedAt;
    this.suspendedAt = null;
    this.canvas.dataset.state = 'running';
    if (this.frame === null) this.frame = requestAnimationFrame(this.draw);
  }

  draw(timestamp) {
    this.frame = null;
    if (!this.active || document.hidden) return;
    const period = this.mode === 'trip' ? 1000 / 30 : 1000 / 60;
    if (timestamp - this.lastDraw >= period - 1) {
      const elapsed = (timestamp - this.started) / 1000;
      const progress = Math.min(1, elapsed * 1000 / this.duration);
      const act = this.mode === 'trip' ? String(Math.min(3, Math.floor(progress * 3) + 1)) : 'death';
      if (this.canvas.dataset.act !== act) this.canvas.dataset.act = act;
      if (elapsed >= 1.7 && this.canvas.dataset.phase !== 'immersed') this.canvas.dataset.phase = 'immersed';
      if (this.graphics) {
        this.graphics.uniform1f(this.uniforms.elapsed, elapsed);
        this.graphics.uniform1f(this.uniforms.mode, this.mode === 'trip' ? 0 : this.mode === 'old-death' ? 1 : 2);
        this.graphics.uniform1f(this.uniforms.reduced, this.reduced ? 1 : 0);
        this.graphics.uniform1f(this.uniforms.progress, progress);
        this.graphics.drawArrays(this.graphics.TRIANGLES, 0, 6);
      } else {
        this.drawFallback(elapsed);
      }
      this.lastDraw = timestamp;
    }
    this.frame = requestAnimationFrame(this.draw);
  }

  drawFallback(elapsed) {
    const context = this.context;
    if (!context) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (this.mode !== 'trip') {
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, width, height);
      if (this.mode === 'old-death') {
        context.globalCompositeOperation = 'lighten';
        context.drawImage(this.portrait, 54.5, 25.5, 210.5, 188.5);
        context.globalCompositeOperation = 'source-over';
      }
      for (let stripe = 0; stripe < 12; stripe++) {
        context.fillStyle = stripe % 3 ? '#000' : '#00ffff';
        context.fillRect(Math.random() * width, Math.random() * height, Math.random() * width, 1 + Math.random() * 8);
      }
      return;
    }
    const progress = Math.min(1, elapsed * 1000 / this.duration);
    const intensity = this.reduced ? 0.2 : 0.4 + progress * 0.6;
    const time = elapsed * (this.reduced ? 0.12 : 0.9 + progress * 0.6);
    context.fillStyle = '#1a001a';
    context.fillRect(0, 0, width, height);
    for (let ring = 35; ring > 0; ring--) {
      context.beginPath();
      for (let segment = 0; segment <= 96; segment++) {
        const angle = segment * Math.PI / 48;
        const radius = ring * 6 + Math.sin(angle * (8 + progress * 8) + time * 3 + ring * 0.3) * (12 + intensity * 18);
        const horizontal = width / 2 + Math.cos(angle + time * 0.18) * radius * (1.12 + Math.sin(time * 0.6) * 0.2);
        const vertical = height / 2 + Math.sin(angle + time * 0.18) * radius;
        if (segment) context.lineTo(horizontal, vertical); else context.moveTo(horizontal, vertical);
      }
      context.closePath();
      context.fillStyle = `hsl(${ring * 31 + time * 85} 100% ${ring % 3 ? 58 : 12}%)`;
      context.fill();
    }
  }
}

export class EndingAudio {
  constructor() {
    this.enabled = true;
    this.scene = '1';
    this.hidden = false;
    this.loading = null;
  }

  unlock() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!this.context) {
      this.context = new Context();
      this.master = this.context.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.context.destination);
      this.noiseGain = this.context.createGain();
      this.noiseGain.connect(this.master);
      this.toneGain = this.context.createGain();
      this.toneGain.connect(this.master);
      this.toneGain.gain.value = 0;
      for (const frequency of [55, 82.5]) {
        const oscillator = this.context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(this.toneGain);
        oscillator.start();
      }
    }
    this.context.resume().catch(() => {});
    if (!this.loading) {
      this.loading = fetch('assets/audio/final-noise.ogg')
        .then(response => { if (!response.ok) throw new Error('Audio unavailable'); return response.arrayBuffer(); })
        .then(bytes => this.context.decodeAudioData(bytes))
        .then(buffer => {
          const source = this.context.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.connect(this.noiseGain);
          source.start();
          this.source = source;
          this.update();
        }).catch(() => {});
    }
    this.update();
  }

  setScene(scene) { this.scene = scene; this.update(); }

  update() {
    if (!this.context) return;
    const now = this.context.currentTime;
    const audible = this.enabled && !this.hidden && this.scene !== 'end';
    const violent = ['3a', '3c', '13a', '14d'].includes(this.scene);
    const trip = isTripScene(this.scene);
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(audible ? 0.24 : 0, now, violent ? 0.01 : 0.2);
    this.noiseGain.gain.setTargetAtTime(violent ? 0.7 : trip ? 0.17 : 0.08, now, 0.03);
    this.toneGain.gain.setTargetAtTime(trip ? 0.045 : 0, now, 0.25);
  }
}
