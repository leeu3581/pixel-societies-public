/**
 * AudioWorklet processor that captures microphone input, downsamples from
 * the browser's native sample rate to 16 kHz, and converts to 16-bit
 * signed PCM (little-endian) — the format Gemini Live API expects.
 *
 * Sends ArrayBuffer chunks via postMessage to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 2048; // ~128ms at 16kHz — good balance of latency vs overhead
    this._buffer = new Float32Array(this._bufferSize);
    this._bufferOffset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;

    const channelData = input[0]; // Float32Array at AudioContext sample rate
    const ratio = sampleRate / 16000;

    // Downsample by nearest-neighbour interpolation
    for (let i = 0; i < channelData.length; i++) {
      const targetIdx = i / ratio;
      if (Math.abs(targetIdx - Math.round(targetIdx)) < 0.5 / ratio) {
        const sample = channelData[i];
        this._buffer[this._bufferOffset++] = sample;

        if (this._bufferOffset >= this._bufferSize) {
          this._flush();
        }
      }
    }

    return true;
  }

  _flush() {
    // Convert Float32 → Int16
    const int16 = new Int16Array(this._bufferOffset);
    for (let i = 0; i < this._bufferOffset; i++) {
      const s = Math.max(-1, Math.min(1, this._buffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    this._bufferOffset = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
