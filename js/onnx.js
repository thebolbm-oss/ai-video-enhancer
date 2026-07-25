/* ==========================================================================
   AI VIDEO ENHANCER — ONNX ENGINE MODULE (js/onnx.js)
   Handles:
   - GPU / WebGPU capability detection
   - ONNX Runtime Web session initialization (WebGPU + WASM fallback)
   - Loading the Real-ESRGAN x4 ONNX model from a LOCAL file the user
     downloads + uploads themselves (no server, no CORS issues)
   - Caching the uploaded model in the browser's Cache Storage so the
     user only has to upload it once — future visits auto-load it
   - Running inference on image tensors
   Requires: onnxruntime-web (loaded globally as `ort` via CDN script in index.html)
   ========================================================================== */

'use strict';

const ONNXEngine = {

  session: null,          // Active ort.InferenceSession
  isLoaded: false,        // Whether the model has been loaded into a session
  activeBackend: 'wasm',  // 'webgpu' | 'wasm' — whichever actually initialized

  // Model input/output tensor name (standard for Real-ESRGAN ONNX exports)
  INPUT_NAME: 'input',
  OUTPUT_NAME: 'output',

  // Direct download link shown to the user in the "Setup AI Model" section.
  // Update this if you move the model to a different release/host.
  MODEL_DOWNLOAD_URL: 'https://github.com/thebolbm-oss/ai-video-enhancer/releases/download/v1.0-model/realesrgan-x4.onnx',

  // Cache Storage identifiers — this is how the model persists across visits
  // once the user has uploaded it a single time.
  CACHE_NAME: 'esrgan-model-cache-v1',
  CACHE_KEY: '/local-model/realesrgan-x4.onnx',

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

  /* ------------------------------------------------------------------
     CHECK IF A MODEL WAS ALREADY UPLOADED + CACHED ON A PREVIOUS VISIT
     Returns true/false. Used at startup to auto-load without asking
     the user to upload again.
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
     LOAD MODEL FROM BROWSER CACHE (repeat visit — no re-upload needed)
     onProgress(percent, stageText)
     ------------------------------------------------------------------ */
  async loadModelFromCache(onProgress = () => {}) {
    if (this.isLoaded && this.session) {
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
    return this._buildSession(buffer, onProgress);
  },

  /* ------------------------------------------------------------------
     LOAD MODEL FROM A USER-UPLOADED FILE
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

    return this._buildSession(buffer, onProgress);
  },

  /* ------------------------------------------------------------------
     SHARED: BUILD THE ONNX RUNTIME SESSION FROM RAW MODEL BYTES
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
     CLEAR THE CACHED MODEL (e.g. user wants to re-upload a new version)
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
    this.session = null;
    this.isLoaded = false;
  },

  /* ------------------------------------------------------------------
     RUN INFERENCE ON A SINGLE IMAGE TENSOR (RGB, CHW, normalized 0-1)
     inputTensorData: Float32Array in shape [1, 3, height, width]
     Returns: { data: Float32Array, dims: number[] }
     ------------------------------------------------------------------ */
  async runInference(inputTensorData, width, height) {
    if (!this.isLoaded || !this.session) {
      throw new Error('AI model is not loaded. Upload the model file in the "Setup AI Model" section first.');
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
     (Does NOT clear the cached model file — just the in-memory session.)
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
  }
};
