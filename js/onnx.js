/* ==========================================================================
   AI VIDEO ENHANCER — ONNX ENGINE MODULE (js/onnx.js)
   Handles:
   - GPU / WebGPU capability detection
   - ONNX Runtime Web session initialization (WebGPU + WASM fallback)
   - Loading the Real-ESRGAN x4 ONNX model
   - Running inference on image tensors
   Requires: onnxruntime-web (loaded globally as `ort` via CDN script in index.html)
   ========================================================================== */

'use strict';

const ONNXEngine = {

  session: null,          // Active ort.InferenceSession
  isLoaded: false,        // Whether the model has been loaded into a session
  activeBackend: 'wasm',  // 'webgpu' | 'wasm' — whichever actually initialized

  // Model file hosted on GitHub Releases — free & unlimited bandwidth
  MODEL_PATH: 'https://github.com/thebolbm-oss/ai-video-enhancer/releases/download/v1.0-model/realesrgan-x4.onnx',

  // Model input/output tensor name (standard for Real-ESRGAN ONNX exports)
  INPUT_NAME: 'input',
  OUTPUT_NAME: 'output',

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
     LOAD THE REAL-ESRGAN MODEL INTO AN INFERENCE SESSION
     onProgress(percent, stageText) is called throughout loading
     ------------------------------------------------------------------ */
  async loadModel(onProgress = () => {}) {
    if (this.isLoaded && this.session) {
      onProgress(100, 'Model already loaded.');
      return this.session;
    }

    try {
      onProgress(5, 'Fetching Real-ESRGAN x4 model...');

      // Fetch the model manually first so we can report download progress,
      // then hand the raw bytes to ONNX Runtime to build the session.
      const response = await fetch(this.MODEL_PATH);
      if (!response.ok) {
        throw new Error(
          `Model file not found at "${this.MODEL_PATH}". Check that the GitHub Release ` +
          `asset exists and the URL is correct, or update ONNXEngine.MODEL_PATH.`
        );
      }

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) {
          const pct = 5 + Math.round((received / total) * 55); // 5-60%
          onProgress(pct, `Downloading model... ${Utils.formatBytes(received)} / ${Utils.formatBytes(total)}`);
        } else {
          onProgress(30, `Downloading model... ${Utils.formatBytes(received)}`);
        }
      }

      const modelBuffer = new Uint8Array(received);
      let position = 0;
      for (const chunk of chunks) {
        modelBuffer.set(chunk, position);
        position += chunk.length;
      }

      onProgress(65, 'Building inference session...');

      // Try preferred backend first, fall back automatically on failure
      const backendsToTry = this.activeBackend === 'webgpu'
        ? ['webgpu', 'wasm']
        : ['wasm'];

      let session = null;
      let lastError = null;

      for (const backend of backendsToTry) {
        try {
          onProgress(75, `Initializing ${backend.toUpperCase()} execution provider...`);
          session = await ort.InferenceSession.create(modelBuffer.buffer, {
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

      onProgress(100, `Model loaded successfully on ${this.activeBackend.toUpperCase()}.`);
      return session;

    } catch (err) {
      this.isLoaded = false;
      this.session = null;
      throw err;
    }
  },

  /* ------------------------------------------------------------------
     RUN INFERENCE ON A SINGLE IMAGE TENSOR (RGB, CHW, normalized 0-1)
     inputTensorData: Float32Array in shape [1, 3, height, width]
     Returns: { data: Float32Array, dims: number[] }
     ------------------------------------------------------------------ */
  async runInference(inputTensorData, width, height) {
    if (!this.isLoaded || !this.session) {
      throw new Error('AI model is not loaded. Call loadModel() first.');
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