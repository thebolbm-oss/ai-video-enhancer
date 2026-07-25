
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

  // FFmpeg core files served from CDN (matches @ffmpeg/ffmpeg version in index.html)
  CORE_BASE_URL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',

  // The main @ffmpeg/ffmpeg package spawns a Web Worker internally to run
  // the heavy processing off the main thread. Browsers require Worker
  // scripts to be same-origin (or a blob: URL) — a plain cross-origin CDN
  // URL gets blocked with a SecurityError. We fix this the same way as the
  // core files: fetch it and convert it to a same-origin blob: URL before
  // handing it to FFmpeg.load(). This exact chunk filename ships with the
  // @ffmpeg/ffmpeg@0.12.10 UMD build referenced in index.html.
  WORKER_URL: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js',

  /* ------------------------------------------------------------------
     LOAD FFMPEG.WASM CORE
     onProgress(percent 0-100, stageText)
     ------------------------------------------------------------------ */
  async loadFFmpeg(onProgress = () => {}) {
    if (this.isLoaded && this.ffmpeg) {
      onProgress(100, 'FFmpeg already loaded.');
      return this.ffmpeg;
    }

    if (typeof FFmpegWASM === 'undefined' && typeof FFmpeg === 'undefined') {
      throw new Error('FFmpeg.wasm failed to load. Check your internet connection.');
    }

    onProgress(10, 'Initializing FFmpeg engine...');

    // The UMD build exposes either `FFmpegWASM.FFmpeg` or `FFmpeg.FFmpeg`
    // depending on CDN version — handle both gracefully.
    const FFmpegClass = (typeof FFmpegWASM !== 'undefined')
      ? FFmpegWASM.FFmpeg
      : FFmpeg.FFmpeg;

    this.ffmpeg = new FFmpegClass();

    this.ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
    });

    onProgress(25, 'Downloading FFmpeg core (WASM)...');

    const coreURL = await FFmpegUtil.toBlobURL(
      `${this.CORE_BASE_URL}/ffmpeg-core.js`,
      'text/javascript'
    );
    const wasmURL = await FFmpegUtil.toBlobURL(
      `${this.CORE_BASE_URL}/ffmpeg-core.wasm`,
      'application/wasm'
    );

    onProgress(55, 'Downloading FFmpeg worker script...');

    // THE FIX: convert the worker script URL to a same-origin blob URL too,
    // exactly like coreURL/wasmURL above — this is what was missing before
    // and caused the "Failed to construct 'Worker'" SecurityError.
    let classWorkerURL;
    try {
      classWorkerURL = await FFmpegUtil.toBlobURL(this.WORKER_URL, 'text/javascript');
    } catch (e) {
      throw new Error(
        `Could not download the FFmpeg worker script from "${this.WORKER_URL}". ` +
        `If FFmpeg updates its version, this chunk filename may have changed — ` +
        `check unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ for the current worker chunk name.`
      );
    }

    onProgress(75, 'Starting FFmpeg core...');

    await this.ffmpeg.load({ coreURL, wasmURL, classWorkerURL });

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

    await ffmpeg.exec([
      '-framerate', String(extractFps),
      '-i', 'enhanced_frame_%04d.png',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      '-preset', 'veryfast',
      'video_no_audio.mp4'
    ]);

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
    const outputData = await ffmpeg.readFile(finalName);
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
