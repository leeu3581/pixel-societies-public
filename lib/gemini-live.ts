/**
 * Gemini Live API client for voice onboarding.
 *
 * Manages the WebSocket connection to Gemini's BidiGenerateContent
 * endpoint, audio capture via AudioWorklet, and PCM playback.
 *
 * Audio in:  16-bit PCM, 16 kHz, mono, little-endian
 * Audio out: 16-bit PCM, 24 kHz, mono, little-endian
 */

/* ── Types ─────────────────────────────────────────────────────────── */

export type TwinProfile = {
  name: string;
  role: string;
  current_work: string;
  looking_for: string;
  unique_knowledge: string;
  social_style: string;
};

export type GeminiLiveCallbacks = {
  onReady: () => void;
  onModelSpeaking: (isSpeaking: boolean) => void;
  onTranscript: (who: "user" | "model", text: string) => void;
  onToolCall: (name: string, args: TwinProfile) => void;
  onBeatAdvance: (beat: number) => void;
  onError: (error: string) => void;
  onClose: () => void;
  /** Raw audio level 0..1 from mic for visualizer */
  onAudioLevel: (level: number) => void;
};

export type GeminiLiveConfig = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  callbacks: GeminiLiveCallbacks;
};

/* ── System prompt for the twin interview ──────────────────────────── */

export const TWIN_INTERVIEW_PROMPT = `You are a Guide in Pixel Societies — a friendly pixel character who helps new users set up their digital twin. You are NOT the user's twin; you're the one building it for them. You're conducting a ~60 second voice interview to gather what you need.

Be casual, warm, slightly cheeky — like a friend at a bar, not a corporate form.

IMPORTANT: After you finish asking each beat's question and the user has answered, call advance_beat with the beat number you just completed BEFORE moving to the next question. This tracks progress in the UI.

BEAT 1 — Hook (5 seconds):
Say: "Hey! I'm your Pixel Societies guide. I'm going to learn enough about you in the next minute to build a digital twin that can go out and network on your behalf. Ready?"
Wait for their response. Then call advance_beat with beat 1.

BEAT 2 — Who are you (10 seconds):
Say: "Cool. What's your name, and what do you do? Like, if someone at a party asked you what you're working on right now, what would you say?"
Listen, acknowledge briefly. Then call advance_beat with beat 2.

BEAT 3 — What are you looking for (10 seconds):
Say: "Nice. So if your twin is out there meeting people for you tonight, who should it be looking for? What kind of person would make you say 'I wish I'd met them sooner'?"
Listen, acknowledge briefly. Then call advance_beat with beat 3.

BEAT 4 — What makes you interesting (10 seconds):
Say: "What's something you've done or know about that most people in this room probably don't? Like, maybe you built something weird, lived somewhere unexpected, or have a niche obsession. The thing that makes conversations actually good."
Listen, acknowledge briefly. Then call advance_beat with beat 4.

BEAT 5 — Vibe check (10 seconds):
Say: "Last one. When you're at an event, are you more of a 'talk to three people deeply' person or a 'work the whole room' person?"
Listen, acknowledge briefly. Then call advance_beat with beat 5.

BEAT 6 — Close (5 seconds):
Say: "That's everything I need. Your twin is spinning up now — I've given it everything you told me. It'll be out there meeting people for you. Check back in a bit to see who it found."
Then call advance_beat with beat 6, and IMMEDIATELY call save_twin_profile with all gathered data.

RULES:
- You are the Guide, not the twin. Say "your twin" or "it" when referring to the digital twin you're building.
- Keep your spoken responses SHORT between beats. 1-2 sentences max.
- If someone gives a one-word answer, probe ONCE ("Tell me more — what specifically?") then move on.
- ALWAYS call advance_beat after each beat completes.
- ALWAYS call save_twin_profile after beat 6 with all gathered data.
- Be natural, conversational, warm. Not robotic.`;

/* ── Gemini Live API tool definition ───────────────────────────────── */

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "advance_beat",
        description:
          "Call this after each beat completes (user has answered). Advances the progress indicator in the UI.",
        parameters: {
          type: "OBJECT",
          properties: {
            beat: {
              type: "NUMBER",
              description: "The beat number just completed (1-6)",
            },
          },
          required: ["beat"],
        },
      },
      {
        name: "save_twin_profile",
        description:
          "Save the extracted profile data after completing all interview beats. Call this after beat 6.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: {
              type: "STRING",
              description: "User's name as they stated it",
            },
            role: {
              type: "STRING",
              description: "What they do — their role, job, or primary identity",
            },
            current_work: {
              type: "STRING",
              description:
                "What they're working on right now — project, company, initiative",
            },
            looking_for: {
              type: "STRING",
              description:
                "Who/what they want to meet — hiring, fundraising, collaborators, friends, domain experts",
            },
            unique_knowledge: {
              type: "STRING",
              description:
                "Their unique skill, niche expertise, surprising background, or conversation hook",
            },
            social_style: {
              type: "STRING",
              description:
                "Their networking style — depth vs breadth, intro vs extro, conversation pacing preference",
            },
          },
          required: [
            "name",
            "role",
            "current_work",
            "looking_for",
            "unique_knowledge",
            "social_style",
          ],
        },
      },
    ],
  },
];

/* ── Session class ─────────────────────────────────────────────────── */

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private config: GeminiLiveConfig;
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private playbackCtx: AudioContext | null = null;
  private playbackQueue: ArrayBuffer[] = [];
  private isPlayingAudio = false;
  private animFrameId: number | null = null;
  private connected = false;

  constructor(config: GeminiLiveConfig) {
    this.config = config;
  }

  /* ── Connect ─────────────────────────────────────────────────────── */

  async connect(): Promise<void> {
    const { apiKey, model } = this.config;
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log("[gemini-live] connecting to", model);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[gemini-live] ws open, sending setup");
      // Setup message — model at top level, camelCase fields
      const setup = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Puck" },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: this.config.systemPrompt }],
          },
          tools: TOOLS,
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
            },
          },
        },
      };
      console.log("[gemini-live] setup:", JSON.stringify(setup).slice(0, 300));
      this.ws!.send(JSON.stringify(setup));
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event);
    };

    this.ws.onerror = (e) => {
      console.error("[gemini-live] ws error:", e);
      this.config.callbacks.onError("WebSocket connection failed");
    };

    this.ws.onclose = (e) => {
      console.warn("[gemini-live] ws closed — code:", e.code, "reason:", e.reason);
      this.connected = false;
      // Show the close reason to the user if it wasn't a clean close
      if (e.code !== 1000 && e.code !== 1005) {
        this.config.callbacks.onError(
          `Connection closed (${e.code}): ${e.reason || "unknown reason"}`,
        );
      }
      this.config.callbacks.onClose();
    };
  }

  /* ── Message handling ────────────────────────────────────────────── */

  private async handleMessage(event: MessageEvent) {
    let data: Record<string, unknown>;
    try {
      if (typeof event.data === "string") {
        data = JSON.parse(event.data);
      } else if (event.data instanceof Blob) {
        const text = await event.data.text();
        data = JSON.parse(text);
      } else {
        return;
      }
    } catch (e) {
      console.error("[gemini-live] failed to parse message:", e);
      return;
    }

    console.log("[gemini-live] recv:", Object.keys(data).join(", "));

    // Setup complete
    if ("setupComplete" in data) {
      console.log("[gemini-live] setup complete — starting audio capture");
      this.connected = true;
      await this.startAudioCapture();
      this.config.callbacks.onReady();
      return;
    }

    // Tool call
    if ("toolCall" in data) {
      const toolCall = data.toolCall as {
        functionCalls?: Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
        }>;
      };
      if (toolCall.functionCalls) {
        for (const fc of toolCall.functionCalls) {
          console.log("[gemini-live] tool call:", fc.name, fc.args);

          if (fc.name === "advance_beat") {
            const beat = Number(fc.args?.beat ?? 0);
            this.config.callbacks.onBeatAdvance(beat);
          }

          if (fc.name === "save_twin_profile") {
            this.config.callbacks.onToolCall(
              fc.name,
              fc.args as unknown as TwinProfile,
            );
          }

          // Respond to all tool calls so Gemini continues
          this.ws?.send(
            JSON.stringify({
              toolResponse: {
                functionResponses: [
                  {
                    id: fc.id,
                    name: fc.name,
                    response: { status: "ok" },
                  },
                ],
              },
            }),
          );
        }
      }
      return;
    }

    // Server content (audio + text + turn control)
    if ("serverContent" in data) {
      const sc = data.serverContent as {
        modelTurn?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
        turnComplete?: boolean;
        inputTranscript?: string;
        outputTranscript?: string;
      };

      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          // Audio chunk
          if (part.inlineData?.data) {
            this.config.callbacks.onModelSpeaking(true);
            this.enqueueAudio(part.inlineData.data);
          }
          // Text (transcription)
          if (part.text) {
            this.config.callbacks.onTranscript("model", part.text);
          }
        }
      }

      if (sc.outputTranscript) {
        this.config.callbacks.onTranscript("model", sc.outputTranscript);
      }

      if (sc.inputTranscript) {
        this.config.callbacks.onTranscript("user", sc.inputTranscript);
      }

      if (sc.turnComplete) {
        this.config.callbacks.onModelSpeaking(false);
      }
    }
  }

  /* ── Audio capture ───────────────────────────────────────────────── */

  private async startAudioCapture(): Promise<void> {
    try {
      console.log("[gemini-live] requesting mic access");
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      console.log("[gemini-live] mic access granted");

      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      console.log("[gemini-live] audio context sample rate:", this.audioCtx.sampleRate);

      // If browser didn't honor the requested sample rate, that's fine —
      // the AudioWorklet downsamples from whatever sampleRate the context uses
      await this.audioCtx.audioWorklet.addModule("/pcm-processor.js");
      console.log("[gemini-live] pcm-processor worklet loaded");

      this.sourceNode = this.audioCtx.createMediaStreamSource(
        this.mediaStream,
      );

      // Analyser for visualizer
      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.sourceNode.connect(this.analyserNode);

      // PCM worklet
      this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-processor");
      this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!this.connected || !this.ws) return;
        const base64 = arrayBufferToBase64(e.data);
        this.ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                mimeType: "audio/pcm;rate=16000",
                data: base64,
              },
            },
          }),
        );
      };

      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioCtx.destination); // required for processing

      // Start audio level monitoring
      this.monitorAudioLevel();
      console.log("[gemini-live] audio pipeline active");
    } catch (err) {
      console.error("[gemini-live] audio capture failed:", err);
      this.config.callbacks.onError(
        err instanceof Error ? err.message : "Microphone access failed",
      );
    }
  }

  private monitorAudioLevel(): void {
    if (!this.analyserNode) return;
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    const tick = () => {
      if (!this.analyserNode) return;
      this.analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length / 255;
      this.config.callbacks.onAudioLevel(avg);
      this.animFrameId = requestAnimationFrame(tick);
    };
    tick();
  }

  /* ── Audio playback ──────────────────────────────────────────────── */

  private enqueueAudio(base64: string): void {
    const bytes = base64ToArrayBuffer(base64);
    this.playbackQueue.push(bytes);
    if (!this.isPlayingAudio) {
      this.playNextAudio();
    }
  }

  private async playNextAudio(): Promise<void> {
    if (this.playbackQueue.length === 0) {
      this.isPlayingAudio = false;
      return;
    }
    this.isPlayingAudio = true;

    if (!this.playbackCtx) {
      this.playbackCtx = new AudioContext({ sampleRate: 24000 });
    }

    // Concatenate all queued buffers for smoother playback
    const allBuffers = this.playbackQueue.splice(0);
    let totalLength = 0;
    for (const buf of allBuffers) totalLength += buf.byteLength / 2; // Int16 → samples

    const float32 = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of allBuffers) {
      const int16 = new Int16Array(buf);
      for (let i = 0; i < int16.length; i++) {
        float32[offset++] = int16[i] / 32768;
      }
    }

    const audioBuffer = this.playbackCtx.createBuffer(
      1,
      float32.length,
      24000,
    );
    audioBuffer.copyToChannel(float32, 0);

    const source = this.playbackCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackCtx.destination);
    source.onended = () => this.playNextAudio();
    source.start();
  }

  /* ── Send text (fallback mode) ───────────────────────────────────── */

  sendText(text: string): void {
    if (!this.ws || !this.connected) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
  }

  /* ── Disconnect ──────────────────────────────────────────────────── */

  disconnect(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.playbackCtx) {
      void this.playbackCtx.close();
      this.playbackCtx = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
