
/* ==========================================================================
   AI VIDEO ENHANCER — VIDEO PROCESSOR MODULE (js/video.js)
   Handles the full video enhancement pipeline using FFmpeg.wasm:
   - Load FFmpeg core (WASM binary) into memory
   - Extract video into individual frames (PNG sequence)
   - Run each frame through Real-ESRGAN (via ImageProcessor logic —
     works automatically with either the full model or the lite model,
     since ImageProcessor.upscaleImage() checks ONNXEngine.activeModelType)
   - Re-encode enhanced frames back into an MP4 using FFmpeg
   - Preserve original audio track by muxing it back in
   Requires: @ffmpeg/ffmpeg + @ffmpeg/util (loaded globally via CDN in index.html)
   ========================================================================== */

'use strict';

const VideoProcessor = {

  ffmpeg: null,
  isLoaded: false,

  // FFmpeg's JS glue code — small text files, self-hosted in this repo
  // (same-origin) instead of a CDN. Required because browsers refuse to
  // construct a Worker from a cross-origin script URL (unpkg.com), no
  // matter what CORS headers are sent. Keeping everything same-origin fixes it.
  CORE_BASE_URL: 'vendor/ffmpeg-core',

  // ffmpeg-core.wasm is ~32MB — too big for GitHub's web "Upload files" UI,
  // which caps browser uploads at 25MB per file. Instead of committing it
  // to the repo, we use the same download+upload+cache pattern as the full
  // Real-ESRGAN model: the user downloads it once from the CDN link below,
  // uploads it through the "Setup Video Engine" section, and the browser
  // saves it into Cache Storage so it's remembered on future visits.
  WASM_DOWNLOAD_URL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
  WASM_CACHE_NAME: 'ffmpeg-core-cache-v1',
  WASM_CACHE_KEY: '/local-wasm/ffmpeg-core.wasm',
  wasmBlobURL: null, // set once the wasm has been loaded from cache or upload

  /* ------------------------------------------------------------------
     CHECK IF ffmpeg-core.wasm WAS ALREADY UPLOADED + CACHED ON A
     PREVIOUS VISIT. Returns true/false.
     ------------------------------------------------------------------ */
  async checkCachedWasm() {
    try {
      if (!('caches' in window)) return false;
      const cache = await caches.open(this.WASM_CACHE_NAME);
      const match = await cache.match(this.WASM_CACHE_KEY);
      return !!match;
    } catch (e) {
      console.warn('checkCachedWasm failed:', e);
      return false;
    }
  },

  /* ------------------------------------------------------------------
     LOAD ffmpeg-core.wasm FROM BROWSER CACHE (repeat visit)
     ------------------------------------------------------------------ */
  async loadWasmFromCache(onProgress = () => {}) {
    onProgress(10, 'Found a saved FFmpeg engine — reading from browser storage...');
    const cache = await caches.open(this.WASM_CACHE_NAME);
    const match = await cache.match(this.WASM_CACHE_KEY);
    if (!match) {
      throw new Error('No cached FFmpeg engine found. Please upload ffmpeg-core.wasm.');
    }
    const blob = await match.blob();
    this.wasmBlobURL = URL.createObjectURL(blob);
    onProgress(100, 'FFmpeg engine ready from cache.');
    return this.wasmBlobURL;
  },

  /* ------------------------------------------------------------------
     LOAD ffmpeg-core.wasm FROM A USER-UPLOADED FILE
     Saves a copy into Cache Storage so future visits don't need re-upload.
     ------------------------------------------------------------------ */
  async loadWasmFromFile(file, onProgress = () => {}) {
    if (!file) throw new Error('No file provided.');
    onProgress(10, `Reading "${file.name}"...`);
    const buffer = await file.arrayBuffer();

    if (!buffer || buffer.byteLength < 1024 * 1024) {
      throw new Error('This does not look like a valid ffmpeg-core.wasm file (too small).');
    }

    onProgress(40, 'Saving FFmpeg engine to browser storage for future visits...');
    try {
      if ('caches' in window) {
        const cache = await caches.open(this.WASM_CACHE_NAME);
        await cache.put(
          this.WASM_CACHE_KEY,
          new Response(buffer.slice(0), {
            headers: {
              'Content-Type': 'application/wasm',
              'Content-Length': String(buffer.byteLength)
            }
          })
        );
      }
    } catch (e) {
      console.warn('Could not cache ffmpeg-core.wasm for future visits:', e);
    }

    const blob = new Blob([buffer], { type: 'application/wasm' });
    this.wasmBlobURL = URL.createObjectURL(blob);
    onProgress(100, 'FFmpeg engine ready.');
    return this.wasmBlobURL;
  },

  /* ------------------------------------------------------------------
     CLEAR THE CACHED WASM (e.g. user wants to re-upload a new version)
     ------------------------------------------------------------------ */
  async clearCachedWasm() {
    try {
      if ('caches' in window) {
        const cache = await caches.open(this.WASM_CACHE_NAME);
        await cache.delete(this.WASM_CACHE_KEY);
      }
    } catch (e) {
      console.warn('clearCachedWasm failed:', e);
    }
    if (this.wasmBlobURL) {
      URL.revokeObjectURL(this.wasmBlobURL);
      this.wasmBlobURL = null;
    }
  },

  /* ------------------------------------------------------------------
     LOAD FFMPEG.WASM CORE
     Requires this.wasmBlobURL to already be set via loadWasmFromCache()
     or loadWasmFromFile() — call one of those first (script.js handles
     this automatically in the "Setup Video Engine" section).
     onProgress(percent 0-100, stageText)
     ------------------------------------------------------------------ */
  async loadFFmpeg(onProgress = () => {}) {
    if (this.isLoaded && this.ffmpeg) {
      onProgress(100, 'FFmpeg already loaded.');
      return this.ffmpeg;
    }

    if (!this.wasmBlobURL) {
      throw new Error(
        'FFmpeg engine (ffmpeg-core.wasm) is not set up yet. Go to the ' +
        '"Setup Video Engine" section, download the file, and upload it there first.'
      );
    }

    if (typeof FFmpegWASM === 'undefined' && typeof FFmpeg === 'undefined') {
      throw new Error('FFmpeg.wasm failed to load. Check that vendor/ffmpeg/ffmpeg.js and vendor/ffmpeg-util/index.js exist in the repo.');
    }

    onProgress(10, 'Initializing FFmpeg engine...');

    // The UMD build exposes either `FFmpegWASM.FFmpeg` or `FFmpeg.FFmpeg`
    // depending on build version — handle both gracefully.
    const FFmpegClass = (typeof FFmpegWASM !== 'undefined')
      ? FFmpegWASM.FFmpeg
      : FFmpeg.FFmpeg;

    // Because ffmpeg.js is now loaded from vendor/ffmpeg/ffmpeg.js (same
    // origin as this page), its internal Worker — which it creates from
    // "814.ffmpeg.js" sitting right next to it in the same folder — now
    // resolves as a same-origin script automatically. No more CORS/Worker
    // SecurityError, and no special workarounds needed here.
    this.ffmpeg = new FFmpegClass();

    this.ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
      if (typeof DebugPanel !== 'undefined') {
        DebugPanel.log('info', `[FFmpeg internal] ${message}`);
      }
    });

    onProgress(30, 'Loading FFmpeg core (local files)...');

    const coreURL = await FFmpegUtil.toBlobURL(
      `${this.CORE_BASE_URL}/ffmpeg-core.js`,
      'text/javascript'
    );
    // wasmURL comes from the already-uploaded/cached blob, not a fetch here
    const wasmURL = this.wasmBlobURL;

    onProgress(70, 'Starting FFmpeg core...');

    await this.ffmpeg.load({ coreURL, wasmURL });

    this.isLoaded = true;
    onProgress(100, 'FFmpeg ready.');
    return this.ffmpeg;
  },

  /* ------------------------------------------------------------------
     MAIN ENTRY POINT — Process a full video file
     settings: { scale, tileSize, faceEnhance, denoise, backend }
     onProgress(percent 0-100, stageText)
     isCancelled(): function returning true if user cancelled
     Returns: { blob, width, height }
     ------------------------------------------------------------------ */
  async processVideo(file, settings, onProgress = () => {}, isCancelled = () => false) {
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg || !this.isLoaded) {
      throw new Error('FFmpeg is not loaded. Call loadFFmpeg() first.');
    }

    onProgress(0, 'Reading video metadata...');
    const meta = await this._getVideoMetadata(file);

    // Limit frame extraction FPS to keep processing time reasonable.
    // Lower FPS for longer videos, higher FPS for short clips.
    const extractFps = meta.duration > 20 ? 8 : meta.duration > 8 ? 12 : 15;

    onProgress(2, 'Loading video into FFmpeg virtual filesystem...');
    const inputName = 'input' + this._getExtension(file.name);
    const fileData = await FFmpegUtil.fetchFile(file);
    await ffmpeg.writeFile(inputName, fileData);

    if (isCancelled()) throw new Error('Processing cancelled by user.');

    /* ---------------- STEP 1: Extract audio track (if present) ---------------- */
    onProgress(5, 'Extracting audio track...');
    let hasAudio = true;
    try {
      await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'copy', 'audio.aac']);
    } catch (e) {
      hasAudio = false; // Some videos have no audio track — that's fine
    }

    if (isCancelled()) throw new Error('Processing cancelled by user.');

    /* ---------------- STEP 2: Extract frames as PNG sequence ---------------- */
    onProgress(8, `Extracting frames at ${extractFps} FPS...`);
    await ffmpeg.exec([
      '-i', inputName,
      '-vf', `fps=${extractFps}`,
      '-q:v', '2',
      'frame_%04d.png'
    ]);

    const frameList = await this._listVirtualFrames(ffmpeg);
    if (frameList.length === 0) {
      throw new Error('No frames were extracted from the video. The file may be corrupted.');
    }

    if (isCancelled()) throw new Error('Processing cancelled by user.');

    /* ---------------- STEP 3: Enhance each frame with Real-ESRGAN ---------------- */
    onProgress(12, `Enhancing ${frameList.length} frames with AI...`);

    const scale = settings.scale || 4;
    let outW = meta.width * scale;
    let outH = meta.height * scale;

    for (let i = 0; i < frameList.length; i++) {
      if (isCancelled()) throw new Error('Processing cancelled by user.');

      const frameName = frameList[i];
      const frameBytes = await ffmpeg.readFile(frameName);
      const frameBlob = new Blob([frameBytes.buffer], { type: 'image/png' });
      const frameFile = new File([frameBlob], frameName, { type: 'image/png' });

      // Reuse the exact same tiling + inference pipeline used for images.
      // This automatically works with whichever model is active (full or lite) —
      // ImageProcessor checks ONNXEngine.activeModelType internally.
      const result = await ImageProcessor.upscaleImage(
        frameFile,
        settings,
        () => {}, // per-tile progress suppressed here; we report per-frame instead
        isCancelled
      );

      outW = result.width;
      outH = result.height;

      const enhancedBuffer = new Uint8Array(await result.blob.arrayBuffer());
      await ffmpeg.writeFile(`enhanced_${frameName}`, enhancedBuffer);

      // Free the original extracted frame from virtual FS to save memory
      await ffmpeg.deleteFile(frameName);

      const framePct = 12 + Math.round(((i + 1) / frameList.length) * 65); // 12-77%
      onProgress(framePct, `Enhanced frame ${i + 1}/${frameList.length}...`);

      await Utils.sleep(0); // yield to keep UI responsive
    }

    if (isCancelled()) throw new Error('Processing cancelled by user.');

    /* ---------------- STEP 4: Re-encode enhanced frames into video ---------------- */
    onProgress(80, 'Merging enhanced frames into video...');

    try {
      await ffmpeg.exec([
        '-framerate', String(extractFps),
        '-i', 'enhanced_frame_%04d.png',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '18',
        '-preset', 'veryfast',
        'video_no_audio.mp4'
      ]);
    } catch (e) {
      const reason = (e && e.message) ? e.message : 'FFmpeg ran out of memory encoding the frames.';
      throw new Error(
        `Merging enhanced frames into a video failed (${reason}). ` +
        `This usually means the device ran out of memory — the enhanced frames ` +
        `are very large at 4x scale. Try again with "Upscale Factor" set to 2x for video.`
      );
    }

    if (isCancelled()) throw new Error('Processing cancelled by user.');

    /* ---------------- STEP 5: Mux audio back in (if it existed) ---------------- */
    let finalName = 'video_no_audio.mp4';

    if (hasAudio) {
      onProgress(92, 'Merging audio track back into video...');
      try {
        await ffmpeg.exec([
          '-i', 'video_no_audio.mp4',
          '-i', 'audio.aac',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          'final_output.mp4'
        ]);
        finalName = 'final_output.mp4';
      } catch (e) {
        console.warn('Audio muxing failed, delivering video-only output:', e);
      }
    }

    onProgress(97, 'Reading final output...');
    let outputData;
    try {
      outputData = await ffmpeg.readFile(finalName);
    } catch (e) {
      const reason = (e && e.message) ? e.message : 'FFmpeg engine stopped responding — most likely it ran out of memory while encoding all the enhanced frames.';
      throw new Error(
        `Failed to read the final video (${reason}). ` +
        `Try again with a lower "Upscale Factor" (2x instead of 4x) for video — ` +
        `it uses far less memory per frame and is much less likely to crash on mobile.`
      );
    }
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });

    /* ---------------- CLEANUP: remove temp files from virtual FS ---------------- */
    await this._cleanupVirtualFS(ffmpeg, inputName, hasAudio, finalName);

    onProgress(100, 'Video enhancement complete!');

    return { blob, width: outW, height: outH };
  },

  /* ------------------------------------------------------------------
     GET VIDEO METADATA (duration, width, height) using a hidden <video>
     ------------------------------------------------------------------ */
  _getVideoMetadata(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const url = URL.createObjectURL(file);

      video.onloadedmetadata = () => {
        const meta = {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight
        };
        URL.revokeObjectURL(url);
        resolve(meta);
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to read video metadata. The file may be corrupted or unsupported.'));
      };

      video.src = url;
    });
  },

  /* ------------------------------------------------------------------
     LIST EXTRACTED FRAME FILES FROM FFMPEG'S VIRTUAL FILESYSTEM
     Returns a sorted array of filenames like ['frame_0001.png', ...]
     ------------------------------------------------------------------ */
  async _listVirtualFrames(ffmpeg) {
    const entries = await ffmpeg.listDir('/');
    return entries
      .map(e => e.name)
      .filter(name => /^frame_\d+\.png$/.test(name))
      .sort();
  },

  /* ------------------------------------------------------------------
     CLEANUP TEMPORARY FILES FROM FFMPEG'S VIRTUAL FILESYSTEM
     Frees memory after processing completes so repeat runs don't leak.
     ------------------------------------------------------------------ */
  async _cleanupVirtualFS(ffmpeg, inputName, hasAudio, finalName) {
    const safeDelete = async (name) => {
      try { await ffmpeg.deleteFile(name); } catch (e) { /* already gone, ignore */ }
    };

    await safeDelete(inputName);
    await safeDelete('video_no_audio.mp4');
    if (hasAudio) await safeDelete('audio.aac');
    if (finalName !== 'video_no_audio.mp4') await safeDelete(finalName);

    try {
      const entries = await ffmpeg.listDir('/');
      const enhancedFrames = entries
        .map(e => e.name)
        .filter(name => name.startsWith('enhanced_frame_'));
      for (const name of enhancedFrames) {
        await safeDelete(name);
      }
    } catch (e) {
      console.warn('Cleanup listing failed (non-critical):', e);
    }
  },

  /* ------------------------------------------------------------------
     GET FILE EXTENSION (with leading dot) FROM A FILENAME
     ------------------------------------------------------------------ */
  _getExtension(filename) {
    const match = filename.match(/\.[0-9a-z]+$/i);
    return match ? match[0] : '.mp4';
  },

  /* ------------------------------------------------------------------
     DISPOSE — terminate FFmpeg worker to free memory
     ------------------------------------------------------------------ */
  async dispose() {
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (e) {
        console.warn('Error terminating FFmpeg:', e);
      }
    }
    this.ffmpeg = null;
    this.isLoaded = false;
  }
};
