export type AYChannel = 0 | 1 | 2;

export interface StereoPan {
  left: number;
  right: number;
}

export interface ChannelLevels {
  a: number;
  b: number;
  c: number;
}

type ChannelLevelTuple = [number, number, number];

export interface AY38910Options {
  clockHz?: number;
  sampleRate?: number;
  masterVolume?: number;
  pan?: [StereoPan, StereoPan, StereoPan];
}

export enum AYRegister {
  ToneAFine = 0,
  ToneACoarse = 1,
  ToneBFine = 2,
  ToneBCoarse = 3,
  ToneCFine = 4,
  ToneCCoarse = 5,
  NoisePeriod = 6,
  Mixer = 7,
  VolumeA = 8,
  VolumeB = 9,
  VolumeC = 10,
  EnvelopeFine = 11,
  EnvelopeCoarse = 12,
  EnvelopeShape = 13,
  PortA = 14,
  PortB = 15
}

const REGISTER_COUNT = 16;
const DEFAULT_CLOCK_HZ = 1_789_772.5;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_PAN: [StereoPan, StereoPan, StereoPan] = [
  { left: 1.0, right: 0.35 },
  { left: 0.7, right: 0.7 },
  { left: 0.35, right: 1.0 }
];

// Normalized approximation of the AY/YM logarithmic volume ladder.
const VOLUME_TABLE = [
  0.0, 0.004, 0.006, 0.009, 0.013, 0.020, 0.030, 0.045,
  0.067, 0.100, 0.149, 0.223, 0.333, 0.500, 0.749, 1.0
] as const;

export class AY38910 {
  readonly registers = new Uint8Array(REGISTER_COUNT);

  clockHz: number;
  sampleRate: number;
  masterVolume: number;
  pan: [StereoPan, StereoPan, StereoPan];

  private tonePhase = [0, 0, 0];
  private noisePhase = 0;
  private noiseOutput = 1;
  private lfsr = 0x1ffff;
  private envelopePhase = 0;
  private envelopeStep = 0;
  private envelopeAlternatePhase = false;
  private envelopeHolding = false;
  private selectedRegister = 0;
  private readonly scratchChannelLevels: ChannelLevelTuple = [0, 0, 0];

  constructor(options: AY38910Options = {}) {
    this.clockHz = options.clockHz ?? DEFAULT_CLOCK_HZ;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.masterVolume = options.masterVolume ?? 0.25;
    this.pan = options.pan ?? DEFAULT_PAN.map((entry) => ({ ...entry })) as [StereoPan, StereoPan, StereoPan];
  }

  reset(): void {
    this.registers.fill(0);
    this.tonePhase = [0, 0, 0];
    this.noisePhase = 0;
    this.noiseOutput = 1;
    this.lfsr = 0x1ffff;
    this.envelopePhase = 0;
    this.envelopeStep = 0;
    this.envelopeAlternatePhase = false;
    this.envelopeHolding = false;
    this.selectedRegister = 0;
  }

  selectRegister(register: number): void {
    this.selectedRegister = register & 0x0f;
  }

  writeSelected(value: number): void {
    this.writeRegister(this.selectedRegister, value);
  }

  readSelected(): number {
    return this.readRegister(this.selectedRegister);
  }

  writeRegister(register: number, value: number): void {
    const index = register & 0x0f;
    const masked = this.maskRegisterValue(index, value);
    this.registers[index] = masked;

    if (index === AYRegister.EnvelopeShape) {
      this.resetEnvelope();
    }
  }

  readRegister(register: number): number {
    return this.registers[register & 0x0f];
  }

  setTonePeriod(channel: AYChannel, period: number): void {
    const fine = channel * 2;
    this.writeRegister(fine, period & 0xff);
    this.writeRegister(fine + 1, (period >> 8) & 0x0f);
  }

  setToneFrequency(channel: AYChannel, frequencyHz: number): void {
    if (frequencyHz <= 0) {
      this.setTonePeriod(channel, 0);
      return;
    }

    const period = Math.max(1, Math.min(0x0fff, Math.round(this.clockHz / (16 * frequencyHz))));
    this.setTonePeriod(channel, period);
  }

  setNoisePeriod(period: number): void {
    this.writeRegister(AYRegister.NoisePeriod, period & 0x1f);
  }

  setMixer(options: {
    toneA?: boolean;
    toneB?: boolean;
    toneC?: boolean;
    noiseA?: boolean;
    noiseB?: boolean;
    noiseC?: boolean;
  }): void {
    let mixer = this.readRegister(AYRegister.Mixer);
    const flags = [
      options.toneA, options.toneB, options.toneC,
      options.noiseA, options.noiseB, options.noiseC
    ];

    flags.forEach((enabled, bit) => {
      if (enabled === undefined) return;
      mixer = enabled ? mixer & ~(1 << bit) : mixer | (1 << bit);
    });

    this.writeRegister(AYRegister.Mixer, mixer);
  }

  setVolume(channel: AYChannel, volume: number, useEnvelope = false): void {
    const clamped = Math.max(0, Math.min(15, Math.round(volume)));
    this.writeRegister(AYRegister.VolumeA + channel, clamped | (useEnvelope ? 0x10 : 0));
  }

  setEnvelope(period: number, shape: number): void {
    this.writeRegister(AYRegister.EnvelopeFine, period & 0xff);
    this.writeRegister(AYRegister.EnvelopeCoarse, (period >> 8) & 0xff);
    this.writeRegister(AYRegister.EnvelopeShape, shape & 0x0f);
  }

  generateMono(target: Float32Array, offset = 0, length = target.length - offset): Float32Array {
    for (let i = 0; i < length; i += 1) {
      target[offset + i] = this.nextMixedSample();
    }
    return target;
  }

  generateStereo(left: Float32Array, right: Float32Array, offset = 0, length = Math.min(left.length, right.length) - offset): void {
    for (let i = 0; i < length; i += 1) {
      const levels = this.nextRawChannelLevels();
      const frameLeft = levels[0] * this.pan[0].left + levels[1] * this.pan[1].left + levels[2] * this.pan[2].left;
      const frameRight = levels[0] * this.pan[0].right + levels[1] * this.pan[1].right + levels[2] * this.pan[2].right;
      left[offset + i] = frameLeft / 3;
      right[offset + i] = frameRight / 3;
    }
  }

  nextSample(): number {
    return this.nextMixedSample();
  }

  nextChannelLevels(): ChannelLevels {
    const levels = this.nextRawChannelLevels();
    return {
      a: levels[0],
      b: levels[1],
      c: levels[2]
    };
  }

  private nextMixedSample(): number {
    const levels = this.nextRawChannelLevels();
    return (levels[0] + levels[1] + levels[2]) / 3;
  }

  private nextRawChannelLevels(): ChannelLevelTuple {
    this.advanceNoise();
    this.advanceEnvelope();
    const mixer = this.readRegister(AYRegister.Mixer);

    this.scratchChannelLevels[0] = this.renderChannel(0, mixer);
    this.scratchChannelLevels[1] = this.renderChannel(1, mixer);
    this.scratchChannelLevels[2] = this.renderChannel(2, mixer);
    return this.scratchChannelLevels;
  }

  private renderChannel(channel: AYChannel, mixer: number): number {
    const toneEnabled = (mixer & (1 << channel)) === 0;
    const noiseEnabled = (mixer & (1 << (channel + 3))) === 0;
    const tone = toneEnabled ? this.advanceTone(channel) : 1;
    const noise = noiseEnabled ? this.noiseOutput : 1;
    const gate = tone & noise;
    const volumeIndex = this.getVolumeIndex(channel);

    return gate === 1 ? VOLUME_TABLE[volumeIndex] * this.masterVolume : 0;
  }

  private advanceTone(channel: AYChannel): 0 | 1 {
    const period = this.getTonePeriod(channel);
    const frequency = this.clockHz / (16 * period);
    this.tonePhase[channel] = (this.tonePhase[channel] + frequency / this.sampleRate) % 1;
    return this.tonePhase[channel] < 0.5 ? 1 : 0;
  }

  private advanceNoise(): void {
    const period = this.getNoisePeriod();
    const frequency = this.clockHz / (16 * period);
    this.noisePhase += frequency / this.sampleRate;

    while (this.noisePhase >= 1) {
      this.noisePhase -= 1;
      const feedback = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (feedback << 16);
      this.noiseOutput = this.lfsr & 1;
    }
  }

  private advanceEnvelope(): void {
    if (this.envelopeHolding) return;

    const period = this.getEnvelopePeriod();
    const frequency = this.clockHz / (256 * period);
    this.envelopePhase += frequency / this.sampleRate;

    while (this.envelopePhase >= 1 && !this.envelopeHolding) {
      this.envelopePhase -= 1;
      this.envelopeStep += 1;
      if (this.envelopeStep >= 16) {
        this.handleEnvelopeCycleEnd();
      }
    }
  }

  private handleEnvelopeCycleEnd(): void {
    const shape = this.readRegister(AYRegister.EnvelopeShape);
    const continueFlag = (shape & 0x08) !== 0;
    const alternate = (shape & 0x02) !== 0;
    const hold = (shape & 0x01) !== 0;

    if (!continueFlag) {
      const attack = this.getEnvelopeAttack();
      this.envelopeStep = attack ? 0 : 15;
      this.envelopeHolding = true;
      return;
    }

    if (alternate) {
      this.envelopeAlternatePhase = !this.envelopeAlternatePhase;
    }

    if (hold) {
      this.envelopeStep = 15;
      this.envelopeHolding = true;
      return;
    }

    this.envelopeStep = 0;
  }

  private getVolumeIndex(channel: AYChannel): number {
    const volumeRegister = this.readRegister(AYRegister.VolumeA + channel);
    if ((volumeRegister & 0x10) === 0) {
      return volumeRegister & 0x0f;
    }

    const attack = this.getEnvelopeAttack();
    return attack ? this.envelopeStep : 15 - this.envelopeStep;
  }

  private resetEnvelope(): void {
    this.envelopePhase = 0;
    this.envelopeStep = 0;
    this.envelopeAlternatePhase = false;
    this.envelopeHolding = false;
  }

  private getEnvelopeAttack(): boolean {
    const attack = (this.readRegister(AYRegister.EnvelopeShape) & 0x04) !== 0;
    return this.envelopeAlternatePhase ? !attack : attack;
  }

  private getTonePeriod(channel: AYChannel): number {
    const fine = this.readRegister(channel * 2);
    const coarse = this.readRegister(channel * 2 + 1) & 0x0f;
    return ((coarse << 8) | fine) || 1;
  }

  private getNoisePeriod(): number {
    return (this.readRegister(AYRegister.NoisePeriod) & 0x1f) || 1;
  }

  private getEnvelopePeriod(): number {
    const fine = this.readRegister(AYRegister.EnvelopeFine);
    const coarse = this.readRegister(AYRegister.EnvelopeCoarse);
    return ((coarse << 8) | fine) || 1;
  }

  private maskRegisterValue(register: number, value: number): number {
    const byte = value & 0xff;
    switch (register) {
      case AYRegister.ToneACoarse:
      case AYRegister.ToneBCoarse:
      case AYRegister.ToneCCoarse:
      case AYRegister.EnvelopeShape:
        return byte & 0x0f;
      case AYRegister.NoisePeriod:
        return byte & 0x1f;
      case AYRegister.VolumeA:
      case AYRegister.VolumeB:
      case AYRegister.VolumeC:
        return byte & 0x1f;
      default:
        return byte;
    }
  }
}
