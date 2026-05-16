import { AY38910, AYRegister, type AYChannel } from "./ay38910";

const COLS = 40;
const ROWS = 25;
const GAME_COLS = 29;
const CELL = 8;
const PLAYER_Y = 18;
const ROAD_SPACES = 11;
const FRAME_MS = 92;
const HAZARD_DELAY_MS = FRAME_MS / 2;
const ORIGINAL_PSG_CLOCK_HZ = 2_000_000;
const PSG_CLOCK_HZ = 1_789_750;
const START_DECAY_TONE_HZ = 880;
const START_DECAY_TONE_PERIOD = Math.round(PSG_CLOCK_HZ / (16 * START_DECAY_TONE_HZ));
const START_DECAY_MS = 1_200;
const START_DECAY_ENVELOPE_PERIOD = Math.round((START_DECAY_MS / 1_000) * PSG_CLOCK_HZ / 4_096);
const ENGINE_REV_STEP_MS = 10;
const CRASH_EFFECT_MS = 900;
const CRASH_EFFECT_FRAME_MS = 70;
const CUSTOM = new Set([224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235]);
const HIGH_SCORE_KEY = "high-drive.high-score";
const TITLE_TEXT_X = 9;
const TITLE_TEXT_Y = 6;
const TITLE_TEXT = "HIGH DRIVE";
const TITLE_PROMPT_X = 9;
const TITLE_PROMPT_Y = 15;
const TITLE_PROMPT = "HIT ANY KEY";
const TITLE_WALL_Y = TITLE_PROMPT_Y - 2;
const CREDIT_URL = "https://github.com/mazfuji/high_drive";
const NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

type GameMode = "title" | "play" | "over" | "bonus_count" | "credits";
type CellBuffer = { code: number; color: string; filter?: string };
type NoteName = "C" | "D" | "E" | "F" | "G" | "A" | "B";
type PlayNote = { name: NoteName; octave: number; accidental: number };
type PlayEvent = { note?: PlayNote; duration: number };

const screen = document.querySelector<SVGSVGElement>("#screen")!;
const cabinet = document.querySelector(".cabinet") as HTMLElement;
const fullscreenButton = document.getElementById("fullscreenButton") as HTMLButtonElement;
const cells: SVGUseElement[] = [];
let creditLink: SVGAElement | null = null;
let psg: PsgPlayer | null = null;
let soundToken = 0;
let soundBlockingToken = 0;
let soundBlocking = false;

const COLORS = {
  main: "#78ff70",
  dim: "#227d39",
  wall: "#f2f2f2",
  road: "#050807",
  text: "#78ff70",
  red: "#ff5959",
  amber: "#ffd95c",
  cyan: "#58e7ff",
  magenta: "#ff58ff",
};

const BONUS_EFFECT_COLORS = [COLORS.wall, COLORS.amber, COLORS.cyan, COLORS.red, COLORS.main];
const CRASH_EFFECT_FILTERS = [
  "brightness(1.8) grayscale(1)",
  "sepia(1) saturate(8) hue-rotate(350deg) brightness(1.25)",
  "sepia(1) saturate(9) hue-rotate(145deg) brightness(1.2)",
  "sepia(1) saturate(10) hue-rotate(315deg) brightness(1.15)",
  "sepia(1) saturate(9) hue-rotate(55deg) brightness(1.25)",
];
const CRASH_FINAL_FILTER = "sepia(1) saturate(10) hue-rotate(250deg) brightness(1.25)";

const state: {
  mode: GameMode;
  playerX: number;
  shadowX: number;
  roadLeft: number;
  score: number;
  highScore: number;
  stage: number;
  tick: number;
  stageTick: number;
  lastMove: number;
  keys: Set<string>;
  chase: { x: number; y: number } | null;
  iceGap: number;
  barrel: { x: number; y: number } | null;
  flash: number;
  bonusRemaining: number;
  delayedHazardToken: number;
} = {
  mode: "title",
  playerX: 14,
  shadowX: 14,
  roadLeft: 8,
  score: 0,
  highScore: loadHighScore(),
  stage: 1,
  tick: 0,
  stageTick: 0,
  lastMove: 0,
  keys: new Set(),
  chase: null,
  iceGap: 9,
  barrel: null,
  flash: 0,
  bonusRemaining: 0,
  delayedHazardToken: 0,
};

const buffer: CellBuffer[][] = Array.from({ length: ROWS }, () =>
  Array.from({ length: COLS }, () => ({ code: 32, color: COLORS.main }))
);

class PsgPlayer {
  private readonly chip = new AY38910({ clockHz: PSG_CLOCK_HZ, sampleRate: 48_000, masterVolume: 0.45 });
  private context: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private playTempo = 120;
  private playToken = 0;
  private playingMml = false;
  private toneOffTimers: Array<number | null> = [null, null, null];

  get isPlayingMml(): boolean {
    return this.playingMml;
  }

  async start(): Promise<void> {
    if (!this.context) {
      const audioWindow = window as Window & {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      this.context = context;
      this.chip.sampleRate = context.sampleRate;
      this.node = context.createScriptProcessor(1024, 0, 1);
      this.node.onaudioprocess = (event) => this.process(event.outputBuffer.getChannelData(0));
      this.node.connect(context.destination);
      this.mute();
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  sound(register: number, value: number): void {
    void this.start();
    this.write(register, value);
  }

  write(register: number, value: number): void {
    this.chip.writeRegister(register, value);
  }

  mute(): void {
    this.stopPlay();
    for (let ch = 0; ch < this.toneOffTimers.length; ch++) {
      if (this.toneOffTimers[ch] !== null) window.clearTimeout(this.toneOffTimers[ch] ?? undefined);
      this.toneOffTimers[ch] = null;
    }
    this.write(AYRegister.Mixer, 63);
    this.write(AYRegister.VolumeA, 0);
    this.write(AYRegister.VolumeB, 0);
    this.write(AYRegister.VolumeC, 0);
  }

  tone(channel: AYChannel, note: PlayNote, duration = 0.08, volume = 12): void {
    void this.start();
    const semitones: Record<NoteName, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const midi = (note.octave + 1) * 12 + semitones[note.name] + note.accidental;
    const freq = 440 * 2 ** ((midi - 69) / 12);
    this.chip.setToneFrequency(channel, freq);
    this.write(AYRegister.Mixer, 0x3f & ~(1 << channel));
    this.chip.setVolume(channel, volume);
    if (this.toneOffTimers[channel] !== null) window.clearTimeout(this.toneOffTimers[channel] ?? undefined);
    this.toneOffTimers[channel] = window.setTimeout(() => {
      this.chip.setVolume(channel, 0);
      this.toneOffTimers[channel] = null;
    }, duration * 1000);
  }

  stopPlay(): void {
    this.playToken++;
    this.playingMml = false;
  }

  async play(mmlOrTempo: string | number, channel: AYChannel = 1, volume = 13): Promise<void> {
    await this.start();
    if (typeof mmlOrTempo === "number") {
      this.playTempo = clamp(mmlOrTempo, 32, 5000);
      return;
    }

    const token = ++this.playToken;
    this.playingMml = true;
    const events = this.parsePlay(mmlOrTempo);
    try {
      for (const event of events) {
        if (token !== this.playToken) return;
        if (event.note) {
          this.tone(channel, event.note, Math.max(0.03, event.duration * 0.9), volume);
        }
        await sleep(event.duration * 1000);
      }
    } finally {
      if (token === this.playToken) this.playingMml = false;
    }
  }

  private parsePlay(mml: string): PlayEvent[] {
    const events: PlayEvent[] = [];
    let octave = 4;
    let defaultLength = 4;
    let tempo = this.playTempo;
    let nextOctaveShift = 0;
    let i = 0;
    while (i < mml.length) {
      const command = mml[i].toUpperCase();
      i++;

      if (command === "O") {
        const number = this.readNumber(mml, i);
        if (number.text) octave = clamp(number.value, 0, 8);
        i = number.index;
        continue;
      }
      if (command === "L") {
        const number = this.readNumber(mml, i);
        if (number.text) defaultLength = clamp(number.value, 1, 64);
        i = number.index;
        continue;
      }
      if (command === "T") {
        const number = this.readNumber(mml, i);
        if (number.text) tempo = clamp(number.value, 32, 5000);
        i = number.index;
        continue;
      }
      if (command === ">") {
        octave = clamp(octave + 1, 0, 8);
        continue;
      }
      if (command === "<") {
        octave = clamp(octave - 1, 0, 8);
        continue;
      }
      if (command === "+") {
        nextOctaveShift = 1;
        continue;
      }
      if (command === "-") {
        nextOctaveShift = -1;
        continue;
      }

      if (!["C", "D", "E", "F", "G", "A", "B", "R"].includes(command)) continue;

      let accidental = 0;
      if (mml[i] === "+" || mml[i] === "#") {
        accidental = 1;
        i++;
      } else if (mml[i] === "-") {
        accidental = -1;
        i++;
      }

      const number = this.readNumber(mml, i);
      i = number.index;
      const length = number.text ? number.value : defaultLength;
      const duration = this.playDuration(length, tempo);
      if (command === "R") {
        events.push({ duration });
      } else {
        events.push({
          note: { name: command as NoteName, octave: clamp(octave + nextOctaveShift, 0, 8), accidental },
          duration,
        });
      }
      nextOctaveShift = 0;
    }
    return events;
  }

  private readNumber(text: string, index: number): { text: string; value: number; index: number } {
    let end = index;
    while (end < text.length && /\d/.test(text[end])) end++;
    const raw = text.slice(index, end);
    return { text: raw, value: raw ? Number.parseInt(raw, 10) : 0, index: end };
  }

  private playDuration(length: number, tempo: number): number {
    return (60 / tempo) * (Math.max(0, length) + 1) / 8;
  }

  private process(output: Float32Array): void {
    if (!this.context) return;
    this.chip.sampleRate = this.context.sampleRate;
    this.chip.generateMono(output);
  }
}

function ensureSound(): void {
  if (!psg) psg = new PsgPlayer();
  void psg.start();
}

function sound(register: number, value: number): void {
  if (!psg) return;
  psg.sound(register, value);
}

function writeTonePeriodFromOriginalClock(channel: AYChannel, fine: number, coarse: number): void {
  const period = ((coarse & 0x0f) << 8) | (fine & 0xff);
  const converted = convertPeriodFromOriginalClock(period);
  sound(channel * 2, converted & 0xff);
  sound(channel * 2 + 1, (converted >> 8) & 0x0f);
}

function writeNoisePeriodFromOriginalClock(value: number): void {
  const period = (value & 0x1f) || 1;
  sound(6, clamp(convertPeriodFromOriginalClock(period), 1, 0x1f));
}

function writeEnvelopePeriodFromOriginalClock(fine: number, coarse: number): void {
  const period = ((coarse & 0xff) << 8) | (fine & 0xff);
  const converted = clamp(convertPeriodFromOriginalClock(period), 1, 0xffff);
  sound(11, converted & 0xff);
  sound(12, (converted >> 8) & 0xff);
}

function convertPeriodFromOriginalClock(period: number): number {
  return Math.max(1, Math.round((period * PSG_CLOCK_HZ) / ORIGINAL_PSG_CLOCK_HZ));
}

function startSoundCue(): void {
  ensureSound();
  const token = ++soundToken;
  void playStartSoundCue(token);
}

async function playStartSoundCue(token: number): Promise<void> {
  await psg?.play(75);
  await psg?.play("O4A1R5A1R5A1R5");
  if (soundToken !== token) return;
  clearTitleWall();
  render();
  const releaseSoundBlock = blockSoundProcessing();
  try {
    sound(0, START_DECAY_TONE_PERIOD & 0xff);
    sound(1, (START_DECAY_TONE_PERIOD >> 8) & 0x0f);
    sound(7, 10);
    sound(8, 31);
    sound(11, START_DECAY_ENVELOPE_PERIOD & 0xff);
    sound(12, (START_DECAY_ENVELOPE_PERIOD >> 8) & 0xff);
    sound(13, 9);
    await sleep(START_DECAY_MS);
  } finally {
    releaseSoundBlock();
  }
  if (soundToken !== token) return;
  preparePlayfield();
  await playEngineRevUp(token);
  if (soundToken === token) engineSound();
}

async function playEngineRevUp(token: number): Promise<void> {
  const releaseSoundBlock = blockSoundProcessing();
  try {
    const targetPitch = currentEnginePitch();
    for (let pitch = 255; pitch > targetPitch; pitch -= 5) {
      if (soundToken !== token) return;
      writeEngineSound(pitch);
      await sleep(ENGINE_REV_STEP_MS);
    }
    if (soundToken === token) writeEngineSound(targetPitch);
  } finally {
    releaseSoundBlock();
  }
}

function engineSound(): void {
  if (!psg || state.mode !== "play") return;
  writeEngineSound(currentEnginePitch());
}

function currentEnginePitch(): number {
  return 40;
  //return clamp(210 - state.stage * 6 - Math.abs(state.lastMove) * 20, 40, 255);
}

function writeEngineSound(pitch: number): void {
  writeTonePeriodFromOriginalClock(0, pitch, 2);
  sound(7, 10);
  sound(8, 31);
  sound(11, 10);
  sound(12, 0);
  sound(13, 10);
}

function crashSound(): void {
  ensureSound();
  const token = ++soundToken;
  writeTonePeriodFromOriginalClock(0, 180, 12);
  writeNoisePeriodFromOriginalClock(63);
  sound(7, 19);
  sound(8, 31);
  writeEnvelopePeriodFromOriginalClock(0, 5);
  sound(13, 9);
  window.setTimeout(() => {
    if (soundToken === token) psg?.mute();
  }, CRASH_EFFECT_MS);
}

function bonusSound(big: boolean): void {
  ensureSound();
  void psg?.play(big ? "O5A0" : "O4A0", 1, 14);
}

function bonusCountSound(): void {
  ensureSound();
  void psg?.play("+C1", 1, 10);
}

function makeScreen(): void {
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "320");
  bg.setAttribute("height", "200");
  bg.setAttribute("fill", "#050807");
  screen.appendChild(bg);

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const use = document.createElementNS(NS, "use");
      use.setAttribute("x", String(x * CELL));
      use.setAttribute("y", String(y * CELL));
      use.setAttribute("width", String(CELL));
      use.setAttribute("height", String(CELL));
      use.style.imageRendering = "pixelated";
      screen.appendChild(use);
      cells.push(use);
    }
  }

  creditLink = document.createElementNS(NS, "a");
  creditLink.setAttribute("href", CREDIT_URL);
  creditLink.setAttributeNS(XLINK, "href", CREDIT_URL);
  creditLink.setAttribute("target", "_blank");
  creditLink.setAttribute("rel", "noopener noreferrer");
  creditLink.style.display = "none";

  const creditText = document.createElementNS(NS, "text");
  creditText.setAttribute("x", String(roadMin() * CELL));
  creditText.setAttribute("y", String(21 * CELL + 7));
  creditText.setAttribute("textLength", String(ROAD_SPACES * CELL));
  creditText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  creditText.setAttribute("font-family", "Arcade8x8ASCII, monospace");
  creditText.setAttribute("font-size", "5");
  creditText.setAttribute("fill", COLORS.cyan);
  creditText.textContent = CREDIT_URL;
  creditLink.appendChild(creditText);
  screen.appendChild(creditLink);
}

function setCell(x: number, y: number, code: number, color = COLORS.main): void {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
  buffer[y][x].code = code;
  buffer[y][x].color = color;
  buffer[y][x].filter = undefined;
}

function printText(x: number, y: number, text: string, color = COLORS.text): void {
  for (let i = 0; i < text.length; i++) setCell(x + i, y, text.charCodeAt(i), color);
}

function fillRect(x: number, y: number, w: number, h: number, code: number, color = COLORS.main): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setCell(xx, yy, code, color);
  }
}

function clearAll(): void {
  fillRect(0, 0, COLS, ROWS, 32);
}

function clearGameArea(): void {
  fillRect(0, 0, GAME_COLS, ROWS, 226);
  for (let y = 0; y < ROWS; y++) drawRoadRow(y, state.roadLeft);
}

function drawRoadRow(y: number, left: number): void {
  for (let x = 0; x < GAME_COLS; x++) setCell(x, y, 226);
  setCell(left, y, 228);
  for (let x = roadMin(); x <= roadMax(); x++) setCell(x, y, 32);
  setCell(roadRight(), y, 227);
}

function title(): void {
  if (psg) psg.mute();
  hideCreditLink();
  resetGame();
  clearAll();
  clearGameArea();
  printText(TITLE_TEXT_X, TITLE_TEXT_Y, TITLE_TEXT, COLORS.amber);
  fillRect(TITLE_PROMPT_X, TITLE_WALL_Y, TITLE_PROMPT.length, 1, 231);
  printText(TITLE_PROMPT_X, TITLE_PROMPT_Y, TITLE_PROMPT, COLORS.text);
  setCell(state.playerX, PLAYER_Y, 224);
  drawStatus();
  render();
}

function resetGame(): void {
  state.mode = "title";
  state.playerX = 14;
  state.shadowX = 14;
  state.roadLeft = 8;
  state.score = 0;
  state.stage = 1;
  state.tick = 0;
  state.stageTick = 0;
  state.lastMove = 0;
  state.chase = null;
  state.iceGap = roadMin();
  state.barrel = null;
  state.flash = 0;
  state.bonusRemaining = 0;
  state.delayedHazardToken = 0;
}

function showCredits(): void {
  state.mode = "credits";
  clearAll();
  clearGameArea();
  printRoadText(4, "HIGH DRIVE", COLORS.amber);
  printRoadText(7, "Copyright", COLORS.text);
  printRoadText(8, "(C) 1984", COLORS.text);
  printRoadText(11, "Hideshi", COLORS.text);
  printRoadText(12, "Matsufuji", COLORS.text);
  showCreditLink();
  drawStatus();
  render();
}

function printRoadText(y: number, text: string, color = COLORS.text): void {
  const x = roadMin() + Math.floor((ROAD_SPACES - text.length) / 2);
  printText(x, y, text, color);
}

function showCreditLink(): void {
  if (creditLink) creditLink.style.display = "";
}

function hideCreditLink(): void {
  if (creditLink) creditLink.style.display = "none";
}

function startGame(): void {
  state.mode = "play";
  state.tick = 0;
  state.stageTick = 0;
  clearTitleText();
  render();
  startSoundCue();
}

function clearTitleText(): void {
  fillRect(TITLE_TEXT_X, TITLE_TEXT_Y, TITLE_TEXT.length, 1, 32);
  fillRect(TITLE_PROMPT_X, TITLE_PROMPT_Y, TITLE_PROMPT.length, 1, 32);
}

function clearTitleWall(): void {
  fillRect(TITLE_PROMPT_X, TITLE_WALL_Y, TITLE_PROMPT.length, 1, 32);
}

function preparePlayfield(): void {
  clearAll();
  clearGameArea();
  setCell(state.playerX, PLAYER_Y, 224);
  drawStatus();
  render();
}

function shiftGameDown(): void {
  for (let y = ROWS - 1; y > 0; y--) {
    for (let x = 0; x < GAME_COLS; x++) {
      buffer[y][x].code = buffer[y - 1][x].code;
      buffer[y][x].color = buffer[y - 1][x].color;
    }
  }
}

function spawnTopRow(): void {
  const section = currentStage();
  const loop = Math.floor((state.stage - 1) / 6);
  drawRoadRow(0, state.roadLeft);

  if (section === 1 && state.stageTick > 0 && state.stageTick % 10 === 0) {
    const gap = randInt(roadMin(), roadMax() - 3);
    for (let x = roadMin(); x <= roadMax(); x++) setCell(x, 0, 231);
    for (let x = gap; x < gap + 4; x++) setCell(x, 0, 32);
  }

  if (section === 2 && Math.random() < Math.min(0.1 + loop * 0.06, 0.34)) {
    setCell(randInt(roadMin(), roadMax()), 0, 225);
  }

  if (section === 3) {
    state.iceGap = clamp(state.iceGap + randInt(-1, 1), roadMin(), roadMax() - 3);
    for (let x = roadMin(); x <= roadMax(); x++) setCell(x, 0, 233);
    for (let x = state.iceGap; x < state.iceGap + 4; x++) setCell(x, 0, 32);
  }

  if (section === 4 && Math.random() < 0.15) setCell(randInt(roadMin(), roadMax()), 0, 233);

  if (section === 4 && state.stageTick > 22 && state.stageTick % 18 === 0) {
    const x0 = randInt(roadMin(), roadMax() - 4);
    for (let x = x0; x < x0 + 5; x++) setCell(x, 0, 234);
  }

  if (section === 5 && Math.random() < Math.min(0.08 + loop * 0.05, 0.28)) {
    setCell(randInt(roadMin(), roadMax()), 0, 225);
  }

  if (section === 6 && Math.random() < 0.2) {
    setCell(randInt(roadMin(), roadMax()), 0, Math.random() < 0.12 ? 230 : 229);
  }
}

function updateChaser(): void {
  if (currentStage() !== 5) return;
  if (!state.chase || state.chase.y > 22) state.chase = { x: randInt(roadMin(), roadMax()), y: 0 };
  const oldX = state.chase.x;
  const oldY = state.chase.y + 1;
  state.chase.x = clamp(state.chase.x + randInt(-1, 1), roadMin(), roadMax());
  state.chase.y += 2;
  if (buffer[oldY]?.[oldX]?.code === 235) setCell(oldX, oldY, 32);
  if (state.chase.x === state.playerX && state.chase.y === PLAYER_Y) {
    crash();
    return;
  }
  if (state.chase.y < ROWS) setCell(state.chase.x, state.chase.y, 235);
}

function updateBarrels(): void {
  if (currentStage() !== 4) return;
  for (let y = ROWS - 1; y >= 0; y--) {
    for (let x = roadMin(); x <= roadMax(); x++) {
      if (buffer[y][x].code !== 234) continue;
      setCell(x, y, 32);
      if (x === state.playerX && y + 1 === PLAYER_Y) {
        crash();
        return;
      }
      if (y + 1 < ROWS) setCell(x, y + 1, 234);
    }
  }
}

function updatePlayer(): void {
  let move = 0;
  if (state.keys.has("ArrowLeft") || state.keys.has("KeyA")) move -= 1;
  if (state.keys.has("ArrowRight") || state.keys.has("KeyD")) move += 1;
  state.lastMove = move;
  state.shadowX = state.playerX;
  const nextX = clamp(state.playerX + move, 1, GAME_COLS - 2);
  const hit = buffer[PLAYER_Y][nextX].code;

  if (hit === 229) {
    state.score += 100;
    bonusSound(false);
  } else if (hit === 230) {
    state.score += 1000;
    bonusSound(true);
  } else if (hit !== 32 && hit !== 232) {
    crash();
    return;
  }

  state.playerX = nextX;
  setCell(state.shadowX, PLAYER_Y + 1, 232);
  setCell(state.playerX, PLAYER_Y, 224);
}

function drawStatus(): void {
  const statusColor = COLORS.wall;
  fillRect(29, 0, 11, ROWS, 32);
  printText(29, 2, "HIGH SCORE", statusColor);
  printText(32, 4, String(state.highScore).padStart(5, " "), statusColor);
  printText(29, 7, "YOUR SCORE", statusColor);
  printText(31, 9, String(state.score).padStart(6, " "), statusColor);
  if (state.stage % 6 === 0) printText(29, 12, "BONUS ROAD", statusColor);
  else printText(29, 12, "ROAD :" + String(state.stage).padStart(4, " "), statusColor);
}

function frame(): void {
  if (isSoundProcessingBlocked()) return;
  if (state.mode === "bonus_count") {
    updateBonusCount();
    return;
  }
  if (state.mode !== "play") return;
  state.tick++;
  state.stageTick++;
  state.score++;
  updateHighScore();

  const stageAtFrameStart = currentStage();
  const delayedHazards = stageAtFrameStart === 4 || stageAtFrameStart === 5;

  shiftGameDown();
  spawnTopRow();
  if (!delayedHazards) {
    updateBarrels();
    if (state.mode !== "play") return;
    updateChaser();
  }
  updatePlayer();
  if (state.mode !== "play") return;
  engineSound();

  if (state.stageTick >= 200) {
    const endedBonusStage = currentStage() === 6;
    state.stage++;
    state.stageTick = 0;
    state.chase = null;
    state.barrel = null;
    state.iceGap = roadMin();
    if (endedBonusStage) startBonusCount(Math.floor(state.score / 10));
  }
  drawStatus();
  render();
  if (delayedHazards && state.mode === "play" && currentStage() === stageAtFrameStart) {
    scheduleDelayedHazards(state.stage, state.stageTick);
  }
}

function scheduleDelayedHazards(stage: number, stageTick: number): void {
  const token = ++state.delayedHazardToken;
  window.setTimeout(() => {
    if (isSoundProcessingBlocked()) {
      scheduleDelayedHazards(stage, stageTick);
      return;
    }
    if (state.mode !== "play") return;
    if (state.delayedHazardToken !== token) return;
    if (state.stage !== stage || state.stageTick !== stageTick) return;
    updateBarrels();
    if (state.mode !== "play") return;
    updateChaser();
    if (state.mode !== "play") return;
    drawStatus();
    render();
  }, HAZARD_DELAY_MS);
}

function startBonusCount(amount: number): void {
  state.mode = "bonus_count";
  state.bonusRemaining = amount;
  ensureSound();
  void psg?.play(5000);
  printBonusCountLabel();
  drawStatus();
  render();
}

function updateBonusCount(): void {
  state.tick++;
  const step = Math.max(1, Math.ceil(state.bonusRemaining / 20));
  const add = Math.min(step, state.bonusRemaining);
  state.score += add;
  state.bonusRemaining -= add;
  updateHighScore();
  printBonusCountLabel();
  drawStatus();
  render();
  if (state.bonusRemaining <= 0) {
    printText(12, 10, "     ", COLORS.main);
    state.mode = "play";
    engineSound();
    render();
  }
}

function printBonusCountLabel(): void {
  printText(12, 10, "BONUS", BONUS_EFFECT_COLORS[state.tick % BONUS_EFFECT_COLORS.length]);
  bonusCountSound();
}

function crash(): void {
  state.mode = "over";
  state.flash = 70;
  crashSound();
  void runCrashEffect();
  drawStatus();
  printText(10, 10, "Try again", COLORS.red);
  printText(9, 12, "[ Y or N ]?", COLORS.red);
  render();
}

async function runCrashEffect(): Promise<void> {
  const token = soundToken;
  const endAt = performance.now() + CRASH_EFFECT_MS;
  let index = 0;
  while (soundToken === token && performance.now() < endAt) {
    const effectIndex = index % BONUS_EFFECT_COLORS.length;
    setCell(state.playerX, PLAYER_Y + 1, 232);
    setCell(state.playerX, PLAYER_Y, 224, BONUS_EFFECT_COLORS[effectIndex]);
    buffer[PLAYER_Y][state.playerX].filter = CRASH_EFFECT_FILTERS[effectIndex];
    render();
    index++;
    await sleep(CRASH_EFFECT_FRAME_MS);
  }
  if (soundToken === token) {
    setCell(state.playerX, PLAYER_Y + 1, 232);
    setCell(state.playerX, PLAYER_Y, 224, COLORS.magenta);
    buffer[PLAYER_Y][state.playerX].filter = CRASH_FINAL_FILTER;
    render();
  }
}

function render(): void {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const item = buffer[y][x];
      const use = cells[y * COLS + x];
      const code = item.code;
      const href = CUSTOM.has(code)
        ? `high_drive_defchr.svg#char-${code}`
        : `arcade_8x8_ascii_font.svg#px-${code >= 32 && code <= 127 ? code : 32}`;
      use.setAttribute("href", href);
      use.setAttributeNS(XLINK, "href", href);
      use.setAttribute("fill", item.color);
      use.style.visibility = code === 32 ? "hidden" : "visible";
      use.style.filter = item.filter ?? "";
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function blockSoundProcessing(): () => void {
  const token = ++soundBlockingToken;
  soundBlocking = true;
  return () => {
    if (soundBlockingToken === token) soundBlocking = false;
  };
}

function isSoundProcessingBlocked(): boolean {
  return soundBlocking || Boolean(psg?.isPlayingMml);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadHighScore(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(HIGH_SCORE_KEY) || "", 10);
    return Number.isFinite(value) && value > 0 ? value : 20000;
  } catch {
    return 20000;
  }
}

function updateHighScore(): void {
  if (state.score <= state.highScore) return;
  state.highScore = state.score;
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(state.highScore));
  } catch {
    // Ignore storage errors; the in-memory score still updates.
  }
}

function currentStage(): number {
  return ((state.stage - 1) % 6) + 1;
}

function roadMin(): number {
  return state.roadLeft + 1;
}

function roadMax(): number {
  return state.roadLeft + ROAD_SPACES;
}

function roadRight(): number {
  return state.roadLeft + ROAD_SPACES + 1;
}

function toggleFullscreen(): void {
  if (!document.fullscreenElement) void cabinet.requestFullscreen?.();
  else void document.exitFullscreen?.();
}

window.addEventListener("keydown", (event) => {
  state.keys.add(event.code);
  if (["ArrowLeft", "ArrowRight", "Space", "KeyA", "KeyD", "KeyF"].includes(event.code)) event.preventDefault();

  if (event.code === "KeyF") {
    toggleFullscreen();
    return;
  }

  if (state.mode === "title") {
    startGame();
    return;
  }
  if (state.mode === "credits") {
    title();
    return;
  }
  if (state.mode === "over") {
    if (event.key === "y" || event.key === "Y") title();
    if (event.key === "n" || event.key === "N") showCredits();
  }
});

window.addEventListener("keyup", (event) => {
  state.keys.delete(event.code);
});

fullscreenButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleFullscreen();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("sw.js");
  });
}

makeScreen();
title();
window.setInterval(frame, FRAME_MS);
