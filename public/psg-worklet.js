"use strict";
var AYRegister;
(function (AYRegister) {
    AYRegister[AYRegister["ToneAFine"] = 0] = "ToneAFine";
    AYRegister[AYRegister["ToneACoarse"] = 1] = "ToneACoarse";
    AYRegister[AYRegister["ToneBFine"] = 2] = "ToneBFine";
    AYRegister[AYRegister["ToneBCoarse"] = 3] = "ToneBCoarse";
    AYRegister[AYRegister["ToneCFine"] = 4] = "ToneCFine";
    AYRegister[AYRegister["ToneCCoarse"] = 5] = "ToneCCoarse";
    AYRegister[AYRegister["NoisePeriod"] = 6] = "NoisePeriod";
    AYRegister[AYRegister["Mixer"] = 7] = "Mixer";
    AYRegister[AYRegister["VolumeA"] = 8] = "VolumeA";
    AYRegister[AYRegister["VolumeB"] = 9] = "VolumeB";
    AYRegister[AYRegister["VolumeC"] = 10] = "VolumeC";
    AYRegister[AYRegister["EnvelopeFine"] = 11] = "EnvelopeFine";
    AYRegister[AYRegister["EnvelopeCoarse"] = 12] = "EnvelopeCoarse";
    AYRegister[AYRegister["EnvelopeShape"] = 13] = "EnvelopeShape";
    AYRegister[AYRegister["PortA"] = 14] = "PortA";
    AYRegister[AYRegister["PortB"] = 15] = "PortB";
})(AYRegister || (AYRegister = {}));
const REGISTER_COUNT = 16;
const DEFAULT_CLOCK_HZ = 1789772.5;
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_PAN = [
    { left: 1.0, right: 0.35 },
    { left: 0.7, right: 0.7 },
    { left: 0.35, right: 1.0 }
];
// Normalized approximation of the AY/YM logarithmic volume ladder.
const VOLUME_TABLE = [
    0.0, 0.004, 0.006, 0.009, 0.013, 0.020, 0.030, 0.045,
    0.067, 0.100, 0.149, 0.223, 0.333, 0.500, 0.749, 1.0
];
class AY38910 {
    constructor(options = {}) {
        this.registers = new Uint8Array(REGISTER_COUNT);
        this.tonePhase = [0, 0, 0];
        this.noisePhase = 0;
        this.noiseOutput = 1;
        this.lfsr = 0x1ffff;
        this.envelopePhase = 0;
        this.envelopeStep = 0;
        this.envelopeAlternatePhase = false;
        this.envelopeHolding = false;
        this.selectedRegister = 0;
        this.scratchChannelLevels = [0, 0, 0];
        this.clockHz = options.clockHz ?? DEFAULT_CLOCK_HZ;
        this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
        this.masterVolume = options.masterVolume ?? 0.25;
        this.pan = options.pan ?? DEFAULT_PAN.map((entry) => ({ ...entry }));
    }
    reset() {
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
    selectRegister(register) {
        this.selectedRegister = register & 0x0f;
    }
    writeSelected(value) {
        this.writeRegister(this.selectedRegister, value);
    }
    readSelected() {
        return this.readRegister(this.selectedRegister);
    }
    writeRegister(register, value) {
        const index = register & 0x0f;
        const masked = this.maskRegisterValue(index, value);
        this.registers[index] = masked;
        if (index === AYRegister.EnvelopeShape) {
            this.resetEnvelope();
        }
    }
    readRegister(register) {
        return this.registers[register & 0x0f];
    }
    setTonePeriod(channel, period) {
        const fine = channel * 2;
        this.writeRegister(fine, period & 0xff);
        this.writeRegister(fine + 1, (period >> 8) & 0x0f);
    }
    setToneFrequency(channel, frequencyHz) {
        if (frequencyHz <= 0) {
            this.setTonePeriod(channel, 0);
            return;
        }
        const period = Math.max(1, Math.min(0x0fff, Math.round(this.clockHz / (16 * frequencyHz))));
        this.setTonePeriod(channel, period);
    }
    setNoisePeriod(period) {
        this.writeRegister(AYRegister.NoisePeriod, period & 0x1f);
    }
    setMixer(options) {
        let mixer = this.readRegister(AYRegister.Mixer);
        const flags = [
            options.toneA, options.toneB, options.toneC,
            options.noiseA, options.noiseB, options.noiseC
        ];
        flags.forEach((enabled, bit) => {
            if (enabled === undefined)
                return;
            mixer = enabled ? mixer & ~(1 << bit) : mixer | (1 << bit);
        });
        this.writeRegister(AYRegister.Mixer, mixer);
    }
    setVolume(channel, volume, useEnvelope = false) {
        const clamped = Math.max(0, Math.min(15, Math.round(volume)));
        this.writeRegister(AYRegister.VolumeA + channel, clamped | (useEnvelope ? 0x10 : 0));
    }
    setEnvelope(period, shape) {
        this.writeRegister(AYRegister.EnvelopeFine, period & 0xff);
        this.writeRegister(AYRegister.EnvelopeCoarse, (period >> 8) & 0xff);
        this.writeRegister(AYRegister.EnvelopeShape, shape & 0x0f);
    }
    generateMono(target, offset = 0, length = target.length - offset) {
        for (let i = 0; i < length; i += 1) {
            target[offset + i] = this.nextMixedSample();
        }
        return target;
    }
    generateStereo(left, right, offset = 0, length = Math.min(left.length, right.length) - offset) {
        for (let i = 0; i < length; i += 1) {
            const levels = this.nextRawChannelLevels();
            const frameLeft = levels[0] * this.pan[0].left + levels[1] * this.pan[1].left + levels[2] * this.pan[2].left;
            const frameRight = levels[0] * this.pan[0].right + levels[1] * this.pan[1].right + levels[2] * this.pan[2].right;
            left[offset + i] = frameLeft / 3;
            right[offset + i] = frameRight / 3;
        }
    }
    nextSample() {
        return this.nextMixedSample();
    }
    nextChannelLevels() {
        const levels = this.nextRawChannelLevels();
        return {
            a: levels[0],
            b: levels[1],
            c: levels[2]
        };
    }
    nextMixedSample() {
        const levels = this.nextRawChannelLevels();
        return (levels[0] + levels[1] + levels[2]) / 3;
    }
    nextRawChannelLevels() {
        this.advanceNoise();
        this.advanceEnvelope();
        const mixer = this.readRegister(AYRegister.Mixer);
        this.scratchChannelLevels[0] = this.renderChannel(0, mixer);
        this.scratchChannelLevels[1] = this.renderChannel(1, mixer);
        this.scratchChannelLevels[2] = this.renderChannel(2, mixer);
        return this.scratchChannelLevels;
    }
    renderChannel(channel, mixer) {
        const toneEnabled = (mixer & (1 << channel)) === 0;
        const noiseEnabled = (mixer & (1 << (channel + 3))) === 0;
        const tone = toneEnabled ? this.advanceTone(channel) : 1;
        const noise = noiseEnabled ? this.noiseOutput : 1;
        const gate = tone & noise;
        const volumeIndex = this.getVolumeIndex(channel);
        return gate === 1 ? VOLUME_TABLE[volumeIndex] * this.masterVolume : 0;
    }
    advanceTone(channel) {
        const period = this.getTonePeriod(channel);
        const frequency = this.clockHz / (16 * period);
        this.tonePhase[channel] = (this.tonePhase[channel] + frequency / this.sampleRate) % 1;
        return this.tonePhase[channel] < 0.5 ? 1 : 0;
    }
    advanceNoise() {
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
    advanceEnvelope() {
        if (this.envelopeHolding)
            return;
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
    handleEnvelopeCycleEnd() {
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
    getVolumeIndex(channel) {
        const volumeRegister = this.readRegister(AYRegister.VolumeA + channel);
        if ((volumeRegister & 0x10) === 0) {
            return volumeRegister & 0x0f;
        }
        const attack = this.getEnvelopeAttack();
        return attack ? this.envelopeStep : 15 - this.envelopeStep;
    }
    resetEnvelope() {
        this.envelopePhase = 0;
        this.envelopeStep = 0;
        this.envelopeAlternatePhase = false;
        this.envelopeHolding = false;
    }
    getEnvelopeAttack() {
        const attack = (this.readRegister(AYRegister.EnvelopeShape) & 0x04) !== 0;
        return this.envelopeAlternatePhase ? !attack : attack;
    }
    getTonePeriod(channel) {
        const fine = this.readRegister(channel * 2);
        const coarse = this.readRegister(channel * 2 + 1) & 0x0f;
        return ((coarse << 8) | fine) || 1;
    }
    getNoisePeriod() {
        return (this.readRegister(AYRegister.NoisePeriod) & 0x1f) || 1;
    }
    getEnvelopePeriod() {
        const fine = this.readRegister(AYRegister.EnvelopeFine);
        const coarse = this.readRegister(AYRegister.EnvelopeCoarse);
        return ((coarse << 8) | fine) || 1;
    }
    maskRegisterValue(register, value) {
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
const PSG_PROCESSOR_NAME = "psg-processor";
class PsgProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.chip = new AY38910({
            clockHz: options?.processorOptions?.clockHz,
            sampleRate,
            masterVolume: options?.processorOptions?.masterVolume,
        });
        this.port.onmessage = (event) => {
            if (event.data.type === "write") {
                this.chip.writeRegister(event.data.register, event.data.value);
            }
        };
    }
    process(_inputs, outputs) {
        this.chip.sampleRate = sampleRate;
        const channel = outputs[0]?.[0];
        if (channel)
            this.chip.generateMono(channel);
        return true;
    }
}
registerProcessor(PSG_PROCESSOR_NAME, PsgProcessor);
//# sourceMappingURL=psg-worklet.js.map