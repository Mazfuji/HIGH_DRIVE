import { AY38910 } from "./ay38910";

const PSG_PROCESSOR_NAME = "psg-processor";

declare const sampleRate: number;

interface AudioWorkletProcessorOptions {
  processorOptions?: {
    clockHz?: number;
    masterVolume?: number;
  };
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletProcessorOptions);
}

declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

type PsgWorkletMessage = {
  type: "write";
  register: number;
  value: number;
};

class PsgProcessor extends AudioWorkletProcessor {
  private readonly chip: AY38910;

  constructor(options?: AudioWorkletProcessorOptions) {
    super(options);
    this.chip = new AY38910({
      clockHz: options?.processorOptions?.clockHz,
      sampleRate,
      masterVolume: options?.processorOptions?.masterVolume,
    });
    this.port.onmessage = (event: MessageEvent<PsgWorkletMessage>) => {
      if (event.data.type === "write") {
        this.chip.writeRegister(event.data.register, event.data.value);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.chip.sampleRate = sampleRate;
    const channel = outputs[0]?.[0];
    if (channel) this.chip.generateMono(channel);
    return true;
  }
}

registerProcessor(PSG_PROCESSOR_NAME, PsgProcessor);
