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
  activeBackend: 'wasm',  // 'webgpu' | 'wasm' — whichever actually initialized
  activeModelType: null,  // 'full' | 'lite' — which model is currently active

  // Model input/output tensor name (standard for Real-ESRGAN ONNX exports)
  INPUT_NAME: 'input',
  OUTPUT_NAME: 'output',

  /* ---------------- FULL MODEL (Real-ESRGAN x4, ~69MB) ---------------- */
  // Direct download link shown to the user in the "Setup AI Model" section.
  // Update this if you move the model to a different release/host.
  MODEL_DOWNLOAD_URL: 'https://github.com/thebolbm-oss/ai-video-enhancer/releases/download/v1.0-model/realesrgan-x4.onnx',

  // Cache Storage identifiers — this is how the full model persists across
  // visits once the user has uploaded it a single time.
  CACHE_NAME: 'esrgan-model-cache-v1',
  CACHE_KEY: '/local-model/realesrgan-x4.onnx',

  /* ---------------- LITE MODEL (RealESR-general-x4v3, ~4.65MB) ---------------- */
  // Bundled in the repo itself — same-origin, no CORS issues, no download step.
  // IMPORTANT: keep the original filenames exactly as extracted — the .onnx
  // file has the .data filename hardcoded inside it as an external-data reference.
  LITE_MODEL_PATH: './models/real_esrgan_general_x4v3.onnx',
  LITE_MODEL_DATA_NAME: 'real_esrgan_general_x4v3.data',
  LITE_MODEL_DATA_PATH: './models/real_esrgan_general_x4v3.data',
  LITE_MODEL_FIXED_TILE: 128, // this model only accepts fixed 128x128 input tiles

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

  /* ------------------------------------------------------------------
     INITIALIZE ONNX RUNTIME ENVIRONMENT
     Configures WASM paths and threading before any session is created.
     ------------------------------------------------------------------ */
  async init(preferredBackend = 'webgpu') {
    if (typeof ort === 'undefined') {
      throw new Error('ONNX Runtime Web failed to load. Check your internet connection.');
    }

    // Point ORT to the CDN-hosted wasm binaries matching the script version
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';

    // Use multiple threads if the browser supports SharedArrayBuffer
    ort.env.wasm.numThreads = (typeof SharedArrayBuffer !== 'undefined')
      ? Math.min(navigator.hardwareConcurrency || 4, 4)
      : 1;

    ort.env.wasm.simd = true;

    this.activeBackend = preferredBackend;
    return true;
  },

  /* ==================================================================
     FULL MODEL METHODS (download + upload + cache workflow)
     ================================================================== */

  /* ------------------------------------------------------------------
     CHECK IF THE FULL MODEL WAS ALREADY UPLOADED + CACHED ON A
     PREVIOUS VISIT. Returns true/false. Used at startup to auto-load
     without asking the user to upload again.
     ------------------------------------------------------------------ */
  async checkCachedModel() {
    try {
      if (!('caches' in window)) return false;
      const cache = await caches.open(this.CACHE_NAME);
      const match = await cache.match(this.CACHE_KEY);
      return !!match;
    } catch (e) {
      console.warn('checkCachedModel failed:', e);
      return false;
    }
  },

  /* ------------------------------------------------------------------
     LOAD FULL MODEL FROM BROWSER CACHE (repeat visit — no re-upload needed)
     onProgress(percent, stageText)
     ------------------------------------------------------------------ */
  async loadModelFromCache(onProgress = () => {}) {
    if (this.isLoaded && this.session && this.activeModelType === 'full') {
      onProgress(100, 'Model already loaded.');
      return this.session;
    }

    onProgress(10, 'Found a saved model — reading from browser storage...');
    const cache = await caches.open(this.CACHE_NAME);
    const match = await cache.match(this.CACHE_KEY);

    if (!match) {
      throw new Error('No cached model found. Please upload the model file.');
    }

    const buffer = await match.arrayBuffer();
    onProgress(40, 'Model bytes loaded from cache.');
    const session = await this._buildSession(buffer, onProgress);
    this.activeModelType = 'full';
    return session;
  },

  /* ------------------------------------------------------------------
     LOAD FULL MODEL FROM A USER-UPLOADED FILE
     Reads the file the user selected (after they downloaded it
     manually), builds an inference session from it, and saves a copy
     into Cache Storage so future visits don't require re-uploading.
     onProgress(percent, stageText)
     ------------------------------------------------------------------ */
  async loadModelFromFile(file, onProgress = () => {}) {
    if (!file) {
      throw new Error('No model file provided.');
    }

    onProgress(5, `Reading "${file.name}"...`);
    const buffer = await file.arrayBuffer();

    if (!buffer || buffer.byteLength < 1024) {
      throw new Error('This does not look like a valid model file (too small).');
    }

    onProgress(25, 'Saving model to browser storage for future visits...');
    try {
      if ('caches' in window) {
        const cache = await caches.open(this.CACHE_NAME);
        await cache.put(
          this.CACHE_KEY,
          new Response(buffer.slice(0), {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(buffer.byteLength)
            }
          })
        );
      }
    } catch (e) {
      // Not fatal — model will still work for this session, just won't persist.
      console.warn('Could not cache model for future visits:', e);
    }

    const session = await this._buildSession(buffer, onProgress);
    this.activeModelType = 'full';
    return session;
  },

  /* ------------------------------------------------------------------
     CLEAR THE CACHED FULL MODEL (e.g. user wants to re-upload a new version)
     ------------------------------------------------------------------ */
  async clearCachedModel() {
    try {
      if ('caches' in window) {
        const cache = await caches.open(this.CACHE_NAME);
        await cache.delete(this.CACHE_KEY);
      }
    } catch (e) {
      console.warn('clearCachedModel failed:', e);
    }
    if (this.activeModelType === 'full') {
      this.session = null;
      this.isLoaded = false;
      this.activeModelType = null;
    }
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
     ------------------------------------------------------------------ */
  async loadLiteModel(onProgress = () => {}) {
    if (this.isLoaded && this.session && this.activeModelType === 'lite') {
      onProgress(100, 'Lite model already loaded.');
      return this.session;
    }

    onProgress(15, 'Loading lightweight model from repo...');

    const backendsToTry = this.activeBackend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
    let session = null;
    let lastError = null;

    for (const backend of backendsToTry) {
      try {
        onProgress(50, `Initializing ${backend.toUpperCase()} for lite model...`);
        session = await ort.InferenceSession.create(this.LITE_MODEL_PATH, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          externalData: [
            {
              path: this.LITE_MODEL_DATA_NAME,
              data: this.LITE_MODEL_DATA_PATH
            }
          ]
        });
        this.activeBackend = backend;
        break;
      } catch (err) {
        console.warn(`Lite model backend "${backend}" failed:`, err);
        lastError = err;
      }
    }

    if (!session) {
      throw lastError || new Error(
        'Failed to load lite model. Make sure both ' +
        '"real_esrgan_general_x4v3.onnx" and "real_esrgan_general_x4v3.data" ' +
        'exist in the /models folder with their original filenames.'
      );
    }

    this.session = session;
    this.isLoaded = true;
    this.activeModelType = 'lite';
    onProgress(100, `Lite model ready on ${this.activeBackend.toUpperCase()}.`);
    return session;
  },

  /* ==================================================================
     SHARED HELPERS
     ================================================================== */

  /* ------------------------------------------------------------------
     SHARED: BUILD THE ONNX RUNTIME SESSION FROM RAW MODEL BYTES
     (used by the full-model flow only — lite model builds its own
     session directly above since it needs the externalData option)
     Tries the preferred backend first (WebGPU), falls back to WASM.
     ------------------------------------------------------------------ */
  async _buildSession(buffer, onProgress = () => {}) {
    onProgress(60, 'Building inference session...');

    const backendsToTry = this.activeBackend === 'webgpu'
      ? ['webgpu', 'wasm']
      : ['wasm'];

    let session = null;
    let lastError = null;

    for (const backend of backendsToTry) {
      try {
        onProgress(75, `Initializing ${backend.toUpperCase()} execution provider...`);
        session = await ort.InferenceSession.create(buffer, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all'
        });
        this.activeBackend = backend;
        break;
      } catch (err) {
        console.warn(`Backend "${backend}" failed, trying next fallback...`, err);
        lastError = err;
      }
    }

    if (!session) {
      throw lastError || new Error('Failed to initialize any execution provider.');
    }

    this.session = session;
    this.isLoaded = true;

    onProgress(100, `Model ready on ${this.activeBackend.toUpperCase()}.`);
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
  async runInference(inputTensorData, width, height) {
    if (!this.isLoaded || !this.session) {
      throw new Error('AI model is not loaded. Choose "Use Lite Model" or upload the full model in the "Setup AI Model" section first.');
    }

    const inputTensor = new ort.Tensor('float32', inputTensorData, [1, 3, height, width]);

    // Build feeds dynamically based on the session's actual input name,
    // since different Real-ESRGAN ONNX exports may name it differently.
    const inputName = this.session.inputNames[0] || this.INPUT_NAME;
    const feeds = { [inputName]: inputTensor };

    const results = await this.session.run(feeds);

    const outputName = this.session.outputNames[0] || this.OUTPUT_NAME;
    const output = results[outputName];

    if (!output) {
      throw new Error('Model produced no output tensor. Check model input/output names.');
    }

    return { data: output.data, dims: output.dims };
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
