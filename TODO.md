# AudioWorklet Performance Plan

- [x] Identify the hot path in `ay38910.ts`: per-sample PSG generation currently runs from `ScriptProcessorNode` on the main thread.
- [x] Add a dedicated AudioWorklet processor that owns the `AY38910` instance and fills output buffers on the audio rendering thread.
- [x] Update the build script to emit `public/psg-worklet.js` from `src/psg-worklet.ts`.
- [x] Route PSG register writes from `PsgPlayer` to the worklet through `MessagePort`.
- [x] Keep a `ScriptProcessorNode` fallback for browsers without `audioWorklet` support.
- [x] Reduce SVG rendering overhead by skipping unchanged cell attributes during `render()`.
- [x] Run a local Chrome headless CPU sample; main thread was mostly idle, with `render()` only appearing at low single-millisecond cost in the sample window.
- [x] Profile the production build locally after the remaining changes; main thread stayed mostly idle, and SVG rendering was not the main sampled CPU cost.
- [x] Reduce `ay38910.ts` hot-path allocation by making `generateMono()`, `generateStereo()`, and `nextSample()` use reusable channel-level storage instead of allocating a `ChannelLevels` object per sample.
