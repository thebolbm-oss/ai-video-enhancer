/* ==========================================================================
   AI VIDEO ENHANCER — ONNX ENGINE MODULE (js/onnx.js)
   Handles TWO model options, side by side:

   1) FULL MODEL (Real-ESRGAN x4, ~69MB) — user downloads it manually,
      then uploads it once via the "Setup AI Model" section. It's saved
      into the browser's Cache Storage so future visits auto-load it
      without re-uploading. Best quality, needs a one-time manual step.

   2) LITE MODEL (RealESR-general-x4v3, ~4.65MB) — bundled directly in
      this repo's /models folder. Loads instantly the moment the page
      opens, no download/upload needed. Slightly lower quality, fixed
      128x128 input tiles, but works out of the box for anyone.

   Whichever the user picks becomes the "active" session — the rest of
   the app (image.js / video.js) just calls ONNXEngine.runInference()
   and doesn't care which one is loaded.

   Also handles:
   - GPU / WebGPU capability detection
   - ONNX Runtime Web session initialization (WebGPU + WASM fallback)
   Requires: onnxruntime-web (loaded globally as `ort` via CDN script in index.html)
   ========================================================================== */

'use strict';

const ONNXEngine = {

  session: null,          // Active ort.InferenceSession
  isLoaded: false,        // Whether the model has been loaded into a session
  isLoading: false,       // Guard flag — prevents overlapping load attempts (e.g. auto-preload + button tap at the same time)
  activeBackend: 'wasm',  // 'webgpu' | 'wasm' — whichever actually initialized
  activeModelType: null,  // 'full' | 'lite' — which model is currently active

  // Model input/output tensor name (standard for Real-ESRGAN ONNX exports)
  INPUT_NAME: 'input',
  OUTPUT_NAME: 'output',

  // Controlled by the CPU <-> WebGPU slider in the UI:
  // null       = auto (try WebGPU first, fall back to WASM if it fails)
  // 'cpu'      = force WASM only, never attempt WebGPU
  // 'webgpu'   = force WebGPU only, no fallback at all (as explicitly requested)
  forcedBackend: 'webgpu',

  /* ---------------- LITE MODEL (RealESR-general-x4v3, ~4.65MB) ---------------- */
  // Bundled in the repo itself — same-origin, no CORS issues, no download step.
  // This is now the ONLY model the app uses — the old 69MB full Real-ESRGAN
  // (download+upload+cache flow) has been removed entirely.
  // IMPORTANT: keep the original filenames exactly as extracted — the .onnx
  // file has the .data filename hardcoded inside it as an external-data reference.
  LITE_MODEL_PATH: './models/real_esrgan_general_x4v3.onnx',
  LITE_MODEL_DATA_NAME: 'real_esrgan_general_x4v3.data',
  LITE_MODEL_DATA_PATH: './models/real_esrgan_general_x4v3.data',
  LITE_MODEL_FIXED_TILE: 128, // this model only accepts fixed 128x128 input tiles

  /* ------------------------------------------------------------------
     CREATE AN ONNX SESSION WITH A HARD TIMEOUT
     Some mobile browsers can hang indefinitely during WebGPU/WASM
     backend initialization instead of failing cleanly. This races the
     session creation against a timer so a stuck attempt always gets
     abandoned instead of freezing the app forever.
     ------------------------------------------------------------------ */
  _createSessionWithTimeout(path, options, timeoutMs) {
    return Promise.race([
      ort.InferenceSession.create(path, options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for backend to initialize.`)), timeoutMs)
      )
    ]);
  },

  /* ------------------------------------------------------------------
     DETECT GPU / WEBGPU AVAILABILITY
     Returns { available: boolean, name: string }
     ------------------------------------------------------------------ */
  async detectGPU() {
    try {
      if (!navigator.gpu) {
        return { available: false, name: 'WebGPU Not Supported' };
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        return { available: false, name: 'No GPU Adapter Found' };
      }

      // Try to get adapter info for a friendly display name
      let gpuName = 'WebGPU Device';
      if (adapter.requestAdapterInfo) {
        try {
          const info = await adapter.requestAdapterInfo();
          if (info && (info.description || info.device)) {
            gpuName = info.description || info.device;
          }
        } catch (e) {
          // requestAdapterInfo not supported in this browser — use fallback name
        }
      }

      return { available: true, name: gpuName };
    } catch (err) {
      console.warn('GPU detection failed:', err);
      return { available: false, name: 'Detection Failed' };
    }
  },

  // Multiple CDN mirrors for the ONNX Runtime Web WASM binaries. If one is
  // blocked or unreachable on a given network, we automatically fall back
  // to the next one instead of hanging forever on a single source.
  ORT_CDN_CANDIDATES: [
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/',
    'https://unpkg.com/onnxruntime-web@1.19.2/dist/'
  ],

  /* ------------------------------------------------------------------
     INITIALIZE ONNX RUNTIME ENVIRONMENT
     Configures WASM paths and threading before any session is created.
     cdnIndex selects which mirror from ORT_CDN_CANDIDATES to use.
     ------------------------------------------------------------------ */
  async init(preferredBackend = 'webgpu', cdnIndex = 0) {
    if (typeof ort === 'undefined') {
      throw new Error('ONNX Runtime Web failed to load. Check your internet connection.');
    }

    // Point ORT to the CDN-hosted wasm binaries matching the script version
    ort.env.wasm.wasmPaths = this.ORT_CDN_CANDIDATES[cdnIndex] || this.ORT_CDN_CANDIDATES[0];

    // Use multiple threads if the browser supports SharedArrayBuffer.
    // This requires cross-origin isolation (COOP/COEP headers), which most
    // static hosts (including GitHub Pages) don't provide by default —
    // so this will normally fall back to a single thread, which is fine.
    ort.env.wasm.numThreads = (typeof SharedArrayBuffer !== 'undefined')
      ? Math.min(navigator.hardwareConcurrency || 4, 8)
      : 1;

    ort.env.wasm.simd = true;

    this.activeBackend = preferredBackend;
    return true;
  },

  /* ==================================================================
     LITE MODEL METHODS (bundled in repo, instant load, no download step)
     ================================================================== */

  /* ------------------------------------------------------------------
     LOAD THE LIGHTWEIGHT MODEL (bundled in repo, loads instantly,
     no download/upload needed — works the moment the page opens).
     This model uses ONNX "external data" format, meaning the .onnx
     file only holds the graph and points to the separate .data file
     for the actual weights — both must be fetched together.

     WebGPU init can hang indefinitely on some mobile browsers instead
     of failing cleanly, which used to get the app stuck forever on
     "Initializing WebGPU for lite model...". Each backend attempt is
     now wrapped in a timeout so a stuck attempt gets abandoned and the
     next backend (WASM) is tried instead, guaranteeing this always
     finishes one way or another.
     ------------------------------------------------------------------ */
  async loadLiteModel(onProgress = () => {}) {
    if (this.isLoaded && this.session && this.activeModelType === 'lite') {
      onProgress(100, 'Lite model already loaded.');
      return this.session;
    }

    if (this.isLoading) {
      throw new Error('A model is already being loaded — please wait for it to finish before trying again.');
    }
    this.isLoading = true;

    try {
      return await this._doLoadLiteModel(onProgress);
    } finally {
      this.isLoading = false;
    }
  },

  async _doLoadLiteModel(onProgress) {
    onProgress(15, 'Loading lightweight model from repo...');

    // Backend selection respects the CPU <-> WebGPU slider:
    // - forcedBackend === 'cpu'    -> WASM only, guaranteed CPU execution
    // - forcedBackend === 'webgpu' -> WebGPU only, NO fallback (exactly as requested)
    // - forcedBackend === null     -> safe default: try WebGPU first, fall back to WASM
    let backendsToTry;
    if (this.forcedBackend === 'cpu') {
      backendsToTry = ['wasm'];
      DebugPanel.log('info', 'Backend slider: forced to CPU (WASM) only.');
    } else if (this.forcedBackend === 'webgpu') {
      backendsToTry = ['webgpu'];
      DebugPanel.log('info', 'Backend slider: forced to WebGPU only — no CPU fallback.');
    } else {
      backendsToTry = ['webgpu', 'wasm'];
    }

    let session = null;
    let lastError = null;
    let usedBackend = null;

    // Try each CDN mirror for the WASM runtime files in turn — if one is
    // blocked/unreachable on this network (common cause of a stuck load),
    // move on to the next instead of failing outright.
    outer:
    for (let cdnIndex = 0; cdnIndex < this.ORT_CDN_CANDIDATES.length; cdnIndex++) {
      const cdnUrl = this.ORT_CDN_CANDIDATES[cdnIndex];

      for (const backend of backendsToTry) {
        try {
          await this.init(backend, cdnIndex);
          onProgress(50, `Initializing ${backend.toUpperCase()} for lite model (source ${cdnIndex + 1}/${this.ORT_CDN_CANDIDATES.length})...`);
          DebugPanel.log('info', `Trying ${backend.toUpperCase()} via CDN: ${cdnUrl}`);

          session = await this._createSessionWithTimeout(
            this.LITE_MODEL_PATH,
            {
              executionProviders: [backend],
              graphOptimizationLevel: 'all',
              externalData: [
                {
                  path: this.LITE_MODEL_DATA_NAME,
                  data: this.LITE_MODEL_DATA_PATH
                }
              ]
            },
            backend === 'webgpu' ? 15000 : 25000 // shorter leash for WebGPU since it's the one known to occasionally hang
          );
          usedBackend = backend;
          DebugPanel.log('success', `Lite model loaded on ${backend.toUpperCase()} via: ${cdnUrl}`);
          break outer;
        } catch (err) {
          console.warn(`Lite model load via ${backend.toUpperCase()} / CDN "${cdnUrl}" failed:`, err);
          DebugPanel.log('warn', `${backend.toUpperCase()} on "${cdnUrl}" failed or timed out — trying next option...`);
          lastError = err;
        }
      }
    }

    if (!session) {
      if (this.forcedBackend === 'webgpu') {
        throw new Error(
          'WebGPU-only mode failed — this device/browser does not support WebGPU (or it errored). ' +
          'Slide the backend control left to "CPU Only" to use WASM instead.'
        );
      }
      throw lastError || new Error(
        'Failed to load lite model. Make sure both ' +
        '"real_esrgan_general_x4v3.onnx" and "real_esrgan_general_x4v3.data" ' +
        'exist in the /models folder with their original filenames.'
      );
    }

    this.activeBackend = usedBackend;
    this.session = session;
    this.isLoaded = true;
    this.activeModelType = 'lite';
    onProgress(100, `Lite model ready on ${this.activeBackend.toUpperCase()}.`);
    return session;
  },

  /* ------------------------------------------------------------------
     RUN INFERENCE ON A SINGLE IMAGE TENSOR (RGB, CHW, normalized 0-1)
     inputTensorData: Float32Array in shape [1, 3, height, width]
     Returns: { data: Float32Array, dims: number[] }

     NOTE: if activeModelType === 'lite', the caller (image.js) must
     pad tiles to exactly LITE_MODEL_FIXED_TILE x LITE_MODEL_FIXED_TILE
     before calling this, since that model only accepts fixed-size input.
     ------------------------------------------------------------------ */
  async runInference(inputTensorData, width, height, session = null) {
    const activeSession = session || this.session;
    if (!this.isLoaded || !activeSession) {
      throw new Error('AI model is not loaded. Choose "Use Lite Model" or upload the full model in the "Setup AI Model" section first.');
    }

    const inputTensor = new ort.Tensor('float32', inputTensorData, [1, 3, height, width]);

    // Build feeds dynamically based on the session's actual input name,
    // since different Real-ESRGAN ONNX exports may name it differently.
    const inputName = activeSession.inputNames[0] || this.INPUT_NAME;
    const feeds = { [inputName]: inputTensor };

    const results = await activeSession.run(feeds);

    const outputName = activeSession.outputNames[0] || this.OUTPUT_NAME;
    const output = results[outputName];

    if (!output) {
      throw new Error('Model produced no output tensor. Check model input/output names.');
    }

    return { data: output.data, dims: output.dims };
  },

  /* ------------------------------------------------------------------
     BOOST MODE SESSION POOL — a single ort.InferenceSession can only
     run one computation at a time internally; calling run() "concurrently"
     on the SAME session just queues the calls one after another under
     the hood, giving no real speedup. To get genuine parallel GPU work,
     we create several fully independent sessions (each with its own
     model weights loaded) and hand tiles out to them round-robin —
     each session can then truly compute at the same time as the others,
     actually loading up the GPU instead of serializing through one queue.
     ------------------------------------------------------------------ */
  sessionPool: [],

  async ensureSessionPool(size) {
    if (this.sessionPool.length >= size) {
      return this.sessionPool.slice(0, size);
    }

    const needed = size - this.sessionPool.length;
    DebugPanel.log('info', `Boost Mode: creating ${needed} additional independent AI session(s) on ${this.activeBackend.toUpperCase()} for true parallel GPU work...`);

    const creations = [];
    for (let i = 0; i < needed; i++) {
      creations.push(
        ort.InferenceSession.create(this.LITE_MODEL_PATH, {
          executionProviders: [this.activeBackend],
          graphOptimizationLevel: 'all',
          externalData: [
            {
              path: this.LITE_MODEL_DATA_NAME,
              data: this.LITE_MODEL_DATA_PATH
            }
          ]
        })
      );
    }

    const newSessions = await Promise.all(creations);
    this.sessionPool.push(...newSessions);
    DebugPanel.log('success', `Boost Mode: session pool ready with ${this.sessionPool.length} parallel session(s).`);
    return this.sessionPool.slice(0, size);
  },

  /* ------------------------------------------------------------------
     DISPOSE SESSION — free GPU/WASM memory when no longer needed
     (Does NOT clear the cached full model file — just the in-memory session.)
     ------------------------------------------------------------------ */
  async dispose() {
    if (this.session) {
      try {
        await this.session.release();
      } catch (e) {
        console.warn('Error releasing ONNX session:', e);
      }
    }
    this.session = null;
    this.isLoaded = false;
    this.activeModelType = null;
  }
};
