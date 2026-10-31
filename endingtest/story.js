export const VISITOR = Object.freeze({ name: 'haff', decision: 'take', source: 'local-fixture' });

export const GOD_PROFILES = Object.freeze([
  Object.freeze({ id: 'merciful', name: 'taburett', response: 'release', role: 'god', source: 'local-fixture' }),
  Object.freeze({ id: 'cruel', name: 'taburett', response: 'kill', role: 'god', source: 'local-fixture' }),
]);

const visitor = (id, name, decision) => Object.freeze({ id, name, decision, role: 'visitor', source: 'local-fixture' });
export const VISITOR_PLANS = Object.freeze([
  Object.freeze({ id: 'take', title: 'Сразу забирает Анторру — A', visitors: Object.freeze([visitor('haff-take', 'haff', 'take')]) }),
  Object.freeze({ id: 'mixed', title: 'Отказ, затем захват — D / E → A', visitors: Object.freeze([visitor('haff-decline', 'haff', 'decline'), visitor('mial-take', 'mial', 'take')]) }),
  Object.freeze({ id: 'repeat', title: 'Два отказа, затем захват — цикл D / E', visitors: Object.freeze([visitor('haff-decline', 'haff', 'decline'), visitor('mial-decline', 'mial', 'decline'), visitor('oazpv-take', 'oazpv', 'take')]) }),
]);

export const isTripScene = id => ['7a', '15d', '15e'].includes(id);

const CONTINUOUS_SCENES = new Set(['4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a', '12a', '13a', '3c', '4c', '5c', '6c', '12d', '13d', '14d', '15d', '14e', '15e']);

export function isSeamlessTransition(from, to, action) {
  return (from === '2' && ((action === 'take' && to === '3a') || (action === 'decline' && to === '3c'))) || (CONTINUOUS_SCENES.has(from) && CONTINUOUS_SCENES.has(to));
}

export const SCENES = Object.freeze([
  { id: '1', node: '91:2', title: 'WHO ARE YOU', tone: 'black' },
  { id: '2', node: '91:27', title: 'TAKE UNTORRA FROM ME?', tone: 'black' },
  { id: '3a', node: '91:117', title: 'Old god dies', tone: 'red', duration: 694, next: '3a-after' },
  { id: '3a-after', title: 'After the killing', tone: 'white', duration: 6507, next: '4a' },
  { id: '4a', node: '91:168', title: 'The old god is dead', tone: 'white', duration: 2000, next: '5a' },
  { id: '5a', node: '92:213', title: 'You have become the new god', tone: 'white', duration: 2400, next: '6a' },
  { id: '6a', node: '92:380', title: 'Enjoy the endless', tone: 'white', duration: 1800, next: '7a' },
  { id: '7a', node: '92:327', title: 'Enjoy UNTORRA', tone: 'white', duration: 74709, next: '8a' },
  { id: '8a', node: '92:396', title: 'Someone is here', tone: 'white', duration: 1600, next: '9a' },
  { id: '9a', node: '92:271', title: 'Ask WHO ARE YOU?', tone: 'white' },
  { id: '10a', node: '92:283', title: 'Visitor introduces themselves', tone: 'white', duration: 2400, next: '11a' },
  { id: '11a', node: '92:292', title: 'Ask TAKE UNTORRA FROM ME?', tone: 'white' },
  { id: '12a', node: '91:106', title: 'Yes', tone: 'black', duration: 2000, next: '13a' },
  { id: '13a', node: '91:112', title: 'You are no longer a god', tone: 'red', duration: 4000, next: 'end' },
  { id: '3b', node: '95:36', title: 'B · Silence after refusal', tone: 'black', duration: 750, next: '4b' },
  { id: '4b', node: '92:348', title: 'B · The god let you go', tone: 'black', duration: 2400, next: '5b' },
  { id: '5b', node: '94:12', title: 'B · A sign of encouragement', tone: 'black', duration: 5000, next: '6b' },
  { id: '6b', node: '95:16', title: 'B · The god reveals their name', tone: 'black', duration: 4000, next: 'end' },
  { id: '3c', node: '95:40', title: 'C · The god kills you', tone: 'red', duration: 694, next: '4c' },
  { id: '4c', node: '92:366', title: 'C · The god did not let you go', tone: 'red', duration: 2400, next: '5c' },
  { id: '5c', node: '95:45', title: 'C · A sign of intimidation', tone: 'red', duration: 3600, next: '6c' },
  { id: '6c', node: '95:51', title: 'C · The god reveals their name', tone: 'red', duration: 4000, next: 'end' },
  { id: '12d', node: '92:301', title: 'The visitor refuses', tone: 'white', duration: 1800, next: '13d' },
  { id: '13d', node: '92:309', title: 'Release or kill the visitor', tone: 'white' },
  { id: '14d', node: '92:322', title: 'E · You killed the visitor', tone: 'red', duration: 694, next: '15d' },
  { id: '15d', node: '96:85', title: 'E · Return to ecstasy', tone: 'white', duration: 32000, next: '8a' },
  { id: '14e', node: '92:317', title: 'D · He left', tone: 'white', duration: 1600, next: '15e' },
  { id: '15e', node: '96:96', title: 'D · Return to ecstasy', tone: 'white', duration: 32000, next: '8a' },
  { id: 'end', title: 'Silence', tone: 'black' },
]);

export const sceneById = id => SCENES.find(scene => scene.id === id);

export function cleanName(value) {
  return Array.from(String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 24).join('');
}

export function transitionFor(id, action, state = {}) {
  if (action === 'auto') return sceneById(id)?.next ?? null;
  if (id === '1' && action === 'name') return '2';
  if (id === '2' && action === 'take') return '3a';
  if (id === '2' && action === 'decline') return state.god?.response === 'kill' ? '3c' : '3b';
  if (id === '9a' && action === 'ask-name') return '10a';
  if (id === '11a' && action === 'ask-claim') return state.visitor?.decision === 'decline' ? '12d' : '12a';
  if (id === '13d' && action === 'release') return '14e';
  if (id === '13d' && action === 'kill') return '14d';
  return null;
}

export function createRun({ godId = 'merciful', visitorPlanId = 'mixed', name = '', runId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const god = GOD_PROFILES.find(profile => profile.id === godId) ?? GOD_PROFILES[0];
  const plan = VISITOR_PLANS.find(profile => profile.id === visitorPlanId) ?? VISITOR_PLANS[1];
  return { runId, scene: '1', name: cleanName(name), god, plan, visitor: null, visitorIndex: -1, encounters: 0, isGod: false, outcome: null, branches: [], decisions: [], preview: false };
}

function recordDecision(state, actor, action, target) {
  state.decisions.push({ sequence: state.decisions.length + 1, encounter: state.encounters, actor: { ...actor }, action, target: { ...target } });
}

function playerActor(state) {
  return { id: state.runId, name: state.name, role: state.outcome === 'A' ? 'former-god' : state.isGod ? 'god' : 'visitor', source: 'local-player' };
}

function receiveVisitor(state) {
  state.visitorIndex += 1;
  state.visitor = state.plan.visitors[Math.min(state.visitorIndex, state.plan.visitors.length - 1)];
  state.encounters += 1;
}

export function advanceRun(state, action) {
  if (state.scene === '1' && action === 'name' && !cleanName(state.name)) return null;
  if (['11a', '13d'].includes(state.scene) && !state.visitor) return null;
  const destination = transitionFor(state.scene, action, state);
  if (!destination) return null;
  const player = playerActor(state);
  if (state.scene === '2' && ['take', 'decline'].includes(action)) {
    recordDecision(state, player, action, state.god);
    if (action === 'take') state.isGod = true;
    else {
      state.outcome = state.god.response === 'release' ? 'B' : 'C';
      state.branches.push(state.outcome);
      recordDecision(state, state.god, state.god.response, player);
    }
  }
  if (state.scene === '11a' && action === 'ask-claim' && state.visitor) {
    recordDecision(state, state.visitor, state.visitor.decision, player);
  }
  if (state.scene === '13d' && ['release', 'kill'].includes(action)) {
    state.branches.push(action === 'release' ? 'D' : 'E');
    recordDecision(state, player, action, state.visitor);
  }
  if (destination === '8a') receiveVisitor(state);
  if (destination === '13a') {
    state.outcome = 'A';
    state.isGod = false;
    state.branches.push('A');
  }
  state.scene = destination;
  return destination;
}

export function previewScene(state, id) {
  if (!sceneById(id)) return null;
  state.preview = true;
  state.scene = id;
  if (id !== '1' && !state.name) state.name = 'you';
  if (/^[3-6]b$/.test(id)) state.god = GOD_PROFILES[0];
  if (/^[3-6]c$/.test(id)) state.god = GOD_PROFILES[1];
  state.isGod = ['3a', '3a-after', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a', '12a', '12d', '13d', '14d', '14e', '15d', '15e'].includes(id);
  if (['8a', '9a', '10a', '11a', '12a', '13a', '12d', '13d', '14d', '14e', '15d', '15e'].includes(id)) {
    const forced = ['12a', '13a'].includes(id) ? 'take' : ['12d', '13d', '14d', '14e', '15d', '15e'].includes(id) ? 'decline' : null;
    state.visitorIndex = Math.max(0, state.plan.visitors.findIndex(profile => !forced || profile.decision === forced));
    state.visitor = state.plan.visitors.find(profile => !forced || profile.decision === forced) ?? visitor(`preview-${forced}`, 'mial', forced);
    state.encounters = 1;
  }
  if (/^[3-6][bc]$/.test(id)) state.outcome = id.endsWith('b') ? 'B' : 'C';
  if (id === '13a') state.outcome = 'A';
  return id;
}

export function decisionSnapshot(state) {
  return JSON.parse(JSON.stringify({ version: 1, mode: 'local-prototype', preview: state.preview, runId: state.runId, player: playerActor(state), god: state.god, visitorPlan: state.plan.id, outcome: state.outcome, branches: state.branches, decisions: state.decisions }));
}

export class SceneClock {
  constructor(onElapsed, { now = () => performance.now(), schedule = (callback, duration) => setTimeout(callback, duration), cancel = timer => clearTimeout(timer) } = {}) {
    this.onElapsed = onElapsed;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.reasons = new Set();
    this.generation = 0;
    this.remaining = null;
    this.timer = null;
  }

  enter(duration) {
    this.stopTimer();
    this.generation += 1;
    this.remaining = Number.isFinite(duration) ? duration : null;
    this.startTimer();
  }

  stopTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  startTimer() {
    if (this.remaining === null || this.reasons.size || this.timer !== null) return;
    const generation = this.generation;
    this.deadline = this.now() + this.remaining;
    this.timer = this.schedule(() => {
      if (generation !== this.generation || this.reasons.size) return;
      this.timer = null;
      this.remaining = null;
      this.onElapsed();
    }, this.remaining);
  }

  pause(reason) {
    if (this.reasons.has(reason)) return;
    if (this.timer !== null) this.remaining = Math.max(0, this.deadline - this.now());
    this.reasons.add(reason);
    this.stopTimer();
  }

  resume(reason) {
    this.reasons.delete(reason);
    this.startTimer();
  }
}
