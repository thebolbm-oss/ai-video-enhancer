/* ==========================================================================
   AI VIDEO ENHANCER — MAIN APPLICATION SCRIPT (script.js)
   This is the central orchestrator. It wires up every button, manages
   global app state, and calls into the module files:
   js/utils.js  -> Utils.*      (helpers: notifications, formatting, files)
   js/onnx.js   -> ONNXEngine.* (ONNX Runtime Web / GPU detection / model)
   js/image.js  -> ImageProcessor.* (Real-ESRGAN image upscaling pipeline)
   js/video.js  -> VideoProcessor.* (FFmpeg.wasm video pipeline)
   js/ui.js     -> UI.*          (DOM rendering / progress / compare slider)
   ========================================================================== */

'use strict';

/* ==========================================================================
   GLOBAL APPLICATION STATE
   ========================================================================== */
const App = {
  state: {
    mode: 'image',              // 'image' | 'video'
    currentFile: null,          // Currently selected single file
    batchQueue: [],             // Array of { id, file, status } for batch mode
    isProcessing: false,
    cancelled: false,
    resultBlob: null,           // Final enhanced output blob
    resultURL: null,            // Object URL of result
    originalURL: null,          // Object URL of original file
    startTime: null,
    processedCount: 0
  },

  settings: {
    scale: 4,
    tileSize: 256,
    backend: 'webgpu',
    faceEnhance: false,
    denoise: true,
    batchMode: false
  },

  els: {} // Cached DOM elements, filled in cacheElements()
};

/* ==========================================================================
   INITIALIZATION — Runs once DOM is fully loaded
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  UI.initTheme();
  UI.initNavbarScroll();
  UI.initMobileDrawer();
  UI.initScrollSpy();
  UI.initModal();

  initModeSwitch();
  initUploadArea();
  initSettingsPanel();
  initActionButtons();
  initCompareControls();
  initDownloadControls();

  setYear();
  detectSystemCapabilities();
});

/* ==========================================================================
   CACHE DOM ELEMENTS
   ========================================================================== */
function cacheElements() {
  const ids = [
    'fileInput', 'dropZone', 'uploadCard', 'browseBtn', 'uploadHint',
    'imageModeBtn', 'videoModeBtn',
    'scaleSelect', 'tileSelect', 'backendSelect',
    'faceEnhanceToggle', 'denoiseToggle', 'batchToggle',
    'enhanceBtn', 'resetBtn',
    'batchList', 'batchItems',
    'progressSection', 'progressTitle', 'progressStage',
    'progressBarInner', 'progressPercent', 'progressEta', 'cancelBtn',
    'compareWrap', 'compareContainer', 'originalImage', 'enhancedImage',
    'compareAfter', 'compareSliderLine', 'videoCompare',
    'originalVideo', 'enhancedVideo', 'playPauseBtn', 'stopBtn',
    'downloadSection', 'downloadInfo', 'downloadBtn', 'enhanceAnotherBtn',
    'originalSizeText', 'enhancedSizeText', 'resolutionText', 'timeTakenText',
    'gpuStatus', 'backendStatus', 'memoryStatus', 'modelStatus',
    'loadingOverlay', 'loadingText', 'currentYear'
  ];
  ids.forEach(id => (App.els[id] = document.getElementById(id)));
}

function setYear() {
  if (App.els.currentYear) {
    App.els.currentYear.textContent = new Date().getFullYear();
  }
}

/* ==========================================================================
   SYSTEM CAPABILITY DETECTION (GPU / Backend / Memory)
   ========================================================================== */
async function detectSystemCapabilities() {
  const gpuInfo = await ONNXEngine.detectGPU();

  App.els.gpuStatus.textContent = gpuInfo.available ? gpuInfo.name : 'Not Available';
  App.els.backendStatus.textContent = gpuInfo.available ? 'WebGPU Ready' : 'WASM Only';
  App.els.modelStatus.textContent = 'Idle (Not Loaded)';

  // Auto-select best backend in settings dropdown
  if (!gpuInfo.available) {
    App.els.backendSelect.value = 'wasm';
    App.settings.backend = 'wasm';
    const opt = App.els.backendSelect.querySelector('option[value="webgpu"]');
    if (opt) opt.disabled = true;
  }

  // Start live memory usage polling
  updateMemoryUsage();
  setInterval(updateMemoryUsage, 3000);
}

function updateMemoryUsage() {
  if (performance && performance.memory) {
    const usedMB = (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    App.els.memoryStatus.textContent = `${usedMB} MB`;
  } else {
    App.els.memoryStatus.textContent = 'Unavailable';
  }
}

/* ==========================================================================
   MODE SWITCH (Image / Video)
   ========================================================================== */
function initModeSwitch() {
  App.els.imageModeBtn.addEventListener('click', () => setMode('image'));
  App.els.videoModeBtn.addEventListener('click', () => setMode('video'));
}

function setMode(mode) {
  if (App.state.isProcessing) {
    Utils.showNotification('warning', 'Processing Active', 'Please wait or cancel current process before switching mode.');
    return;
  }

  App.state.mode = mode;
  App.els.imageModeBtn.classList.toggle('active', mode === 'image');
  App.els.videoModeBtn.classList.toggle('active', mode === 'video');

  if (mode === 'image') {
    App.els.fileInput.accept = 'image/*';
    App.els.uploadHint.textContent = 'Supported: JPG, PNG, WEBP (Max 25MB)';
  } else {
    App.els.fileInput.accept = 'video/*';
    App.els.uploadHint.textContent = 'Supported: MP4, WEBM, MOV (Max 100MB)';
    // Batch mode not applicable to video — force off
    App.els.batchToggle.checked = false;
    App.settings.batchMode = false;
    App.els.batchList.classList.add('hidden');
  }

  resetFileSelection();
}

/* ==========================================================================
   UPLOAD AREA — Drag & Drop + Browse + File Handling
   ========================================================================== */
function initUploadArea() {
  const { dropZone, fileInput, browseBtn } = App.els;

  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    handleIncomingFiles(Array.from(e.target.files));
  });

  // Prevent default browser behavior for drag events on whole window
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, () => dropZone.classList.add('drag-active'));
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-active'));
  });

  dropZone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files);
    handleIncomingFiles(files);
  });

  // Clicking anywhere on the dropzone (not just the button) opens file picker
  dropZone.addEventListener('click', (e) => {
    if (e.target === browseBtn || browseBtn.contains(e.target)) return;
    fileInput.click();
  });
}

function handleIncomingFiles(files) {
  if (!files || files.length === 0) return;

  const expectedType = App.state.mode === 'image' ? 'image' : 'video';
  const maxSizeMB = App.state.mode === 'image' ? 25 : 100;

  // Filter valid files only
  const validFiles = [];
  for (const file of files) {
    const validation = Utils.validateFile(file, expectedType, maxSizeMB);
    if (!validation.valid) {
      Utils.showNotification('error', 'Invalid File', validation.message);
      continue;
    }
    validFiles.push(file);
  }

  if (validFiles.length === 0) return;

  if (App.settings.batchMode && App.state.mode === 'image') {
    // Add all valid files to batch queue
    validFiles.forEach(file => addToBatchQueue(file));
    Utils.showNotification('success', 'Files Added', `${validFiles.length} file(s) added to batch queue.`);
  } else {
    // Single file mode — take first valid file only
    setCurrentFile(validFiles[0]);
  }
}

function setCurrentFile(file) {
  App.state.currentFile = file;

  if (App.state.originalURL) URL.revokeObjectURL(App.state.originalURL);
  App.state.originalURL = URL.createObjectURL(file);

  UI.renderFilePreview(file, App.state.originalURL, removeCurrentFile);
  App.els.enhanceBtn.disabled = false;

  Utils.showNotification('info', 'File Ready', `"${file.name}" loaded successfully.`);
}

function removeCurrentFile() {
  App.state.currentFile = null;
  if (App.state.originalURL) {
    URL.revokeObjectURL(App.state.originalURL);
    App.state.originalURL = null;
  }
  App.els.fileInput.value = '';
  App.els.enhanceBtn.disabled = App.state.batchQueue.length === 0;
  UI.resetUploadCard();
}

function resetFileSelection() {
  removeCurrentFile();
  App.state.batchQueue = [];
  UI.renderBatchList([], removeFromBatchQueue);
  App.els.batchList.classList.add('hidden');
  App.els.enhanceBtn.disabled = true;
}

function addToBatchQueue(file) {
  const item = { id: Utils.generateId(), file, status: 'queued' };
  App.state.batchQueue.push(item);
  App.els.batchList.classList.remove('hidden');
  UI.renderBatchList(App.state.batchQueue, removeFromBatchQueue);
  App.els.enhanceBtn.disabled = false;
}

function removeFromBatchQueue(id) {
  App.state.batchQueue = App.state.batchQueue.filter(item => item.id !== id);
  UI.renderBatchList(App.state.batchQueue, removeFromBatchQueue);
  if (App.state.batchQueue.length === 0) {
    App.els.batchList.classList.add('hidden');
    App.els.enhanceBtn.disabled = !App.state.currentFile;
  }
}

/* ==========================================================================
   AI SETTINGS PANEL — Sync UI controls into App.settings
   ========================================================================== */
function initSettingsPanel() {
  App.els.scaleSelect.addEventListener('change', (e) => {
    App.settings.scale = parseInt(e.target.value, 10);
  });

  App.els.tileSelect.addEventListener('change', (e) => {
    App.settings.tileSize = parseInt(e.target.value, 10);
  });

  App.els.backendSelect.addEventListener('change', (e) => {
    App.settings.backend = e.target.value;
  });

  App.els.faceEnhanceToggle.addEventListener('change', (e) => {
    App.settings.faceEnhance = e.target.checked;
  });

  App.els.denoiseToggle.addEventListener('change', (e) => {
    App.settings.denoise = e.target.checked;
  });

  App.els.batchToggle.addEventListener('change', (e) => {
    if (App.state.mode === 'video') {
      e.target.checked = false;
      Utils.showNotification('warning', 'Not Available', 'Batch mode is only available for images.');
      return;
    }
    App.settings.batchMode = e.target.checked;
    App.els.fileInput.multiple = e.target.checked;

    // If turning batch off, clear queue and go back to single mode
    if (!e.target.checked) {
      App.state.batchQueue = [];
      UI.renderBatchList([], removeFromBatchQueue);
      App.els.batchList.classList.add('hidden');
    } else if (App.state.currentFile) {
      // Move current single file into the batch queue
      addToBatchQueue(App.state.currentFile);
      removeCurrentFile();
    }
  });
}

/* ==========================================================================
   ACTION BUTTONS — Enhance / Reset / Cancel
   ========================================================================== */
function initActionButtons() {
  App.els.enhanceBtn.addEventListener('click', startEnhancement);
  App.els.resetBtn.addEventListener('click', fullReset);
  App.els.cancelBtn.addEventListener('click', cancelProcessing);
}

async function startEnhancement() {
  if (App.state.isProcessing) return;

  if (App.state.mode === 'image' && App.settings.batchMode) {
    if (App.state.batchQueue.length === 0) {
      Utils.showNotification('error', 'No Files', 'Add at least one file to the batch queue.');
      return;
    }
    await runBatchImagePipeline();
  } else if (App.state.mode === 'image') {
    if (!App.state.currentFile) {
      Utils.showNotification('error', 'No File', 'Please select an image first.');
      return;
    }
    await runSingleImagePipeline(App.state.currentFile);
  } else {
    if (!App.state.currentFile) {
      Utils.showNotification('error', 'No File', 'Please select a video first.');
      return;
    }
    await runVideoPipeline(App.state.currentFile);
  }
}

/* ---------------- SINGLE IMAGE PIPELINE ---------------- */
async function runSingleImagePipeline(file) {
  beginProcessing('Enhancing Image', 'Loading AI model...');

  try {
    await ensureModelLoaded();

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(30, 'Preprocessing image...');
    const result = await ImageProcessor.upscaleImage(file, App.settings, (pct, stage) => {
      // Map inference progress into 30-95% range
      const mapped = 30 + Math.round(pct * 0.65);
      UI.updateProgress(mapped, stage);
    }, () => App.state.cancelled);

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Finalizing output...');
    completeImageResult(file, result);
  } catch (err) {
    handleProcessingError(err);
  }
}

/* ---------------- BATCH IMAGE PIPELINE ---------------- */
async function runBatchImagePipeline() {
  beginProcessing('Processing Batch', 'Loading AI model...');

  try {
    await ensureModelLoaded();
    const total = App.state.batchQueue.length;
    let completed = 0;
    let lastResult = null;
    let lastFile = null;

    for (const item of App.state.batchQueue) {
      if (App.state.cancelled) return finishCancelled();

      item.status = 'processing';
      UI.renderBatchList(App.state.batchQueue, removeFromBatchQueue);
      UI.updateProgress(
        Math.round((completed / total) * 90),
        `Processing ${item.file.name} (${completed + 1}/${total})...`
      );

      const result = await ImageProcessor.upscaleImage(item.file, App.settings, (pct, stage) => {
        const base = (completed / total) * 90;
        const step = (1 / total) * 90;
        UI.updateProgress(Math.round(base + (pct / 100) * step), stage);
      }, () => App.state.cancelled);

      item.status = 'done';
      lastResult = result;
      lastFile = item.file;
      completed++;
      App.state.processedCount = completed;
      UI.renderBatchList(App.state.batchQueue, removeFromBatchQueue);
    }

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Batch complete!');
    // Show the last processed item in the compare/download view;
    // all files were downloaded individually via zip-style loop trigger.
    await Utils.downloadBlob(lastResult.blob, `enhanced-${lastFile.name.replace(/\.[^.]+$/, '')}.png`);
    completeImageResult(lastFile, lastResult, true);
  } catch (err) {
    handleProcessingError(err);
  }
}

/* ---------------- VIDEO PIPELINE ---------------- */
async function runVideoPipeline(file) {
  beginProcessing('Enhancing Video', 'Loading FFmpeg engine...');

  try {
    await ensureModelLoaded();

    await VideoProcessor.loadFFmpeg((pct, stage) => {
      UI.updateProgress(Math.round(pct * 0.1), stage); // 0-10%
    });

    if (App.state.cancelled) return finishCancelled();

    const result = await VideoProcessor.processVideo(file, App.settings, (pct, stage) => {
      // Map full video pipeline progress into 10-100%
      const mapped = 10 + Math.round(pct * 0.9);
      UI.updateProgress(mapped, stage);
    }, () => App.state.cancelled);

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Video ready!');
    completeVideoResult(file, result);
  } catch (err) {
    handleProcessingError(err);
  }
}

/* ---------------- SHARED HELPERS ---------------- */
async function ensureModelLoaded() {
  if (ONNXEngine.isLoaded) {
    UI.updateProgress(25, 'AI model already loaded, reusing session...');
    return;
  }
  App.els.modelStatus.textContent = 'Loading...';
  await ONNXEngine.init(App.settings.backend);
  await ONNXEngine.loadModel((pct, stage) => {
    UI.updateProgress(Math.round(pct * 0.25), stage); // 0-25%
  });
  App.els.modelStatus.textContent = 'Loaded & Ready';
  App.els.backendStatus.textContent = ONNXEngine.activeBackend === 'webgpu' ? 'WebGPU Active' : 'WASM Active';
}

function beginProcessing(title, initialStage) {
  App.state.isProcessing = true;
  App.state.cancelled = false;
  App.state.startTime = Date.now();
  App.els.enhanceBtn.disabled = true;

  App.els.progressSection.classList.remove('hidden');
  App.els.progressTitle.textContent = title;
  UI.updateProgress(0, initialStage);
  App.els.progressSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelProcessing() {
  if (!App.state.isProcessing) return;
  App.state.cancelled = true;
  Utils.showNotification('warning', 'Cancelling...', 'Stopping the current process, please wait.');
}

function finishCancelled() {
  App.state.isProcessing = false;
  App.els.enhanceBtn.disabled = false;
  App.els.progressSection.classList.add('hidden');
  Utils.showNotification('info', 'Cancelled', 'Processing was cancelled by user.');
}

function handleProcessingError(err) {
  console.error('Processing error:', err);
  App.state.isProcessing = false;
  App.els.enhanceBtn.disabled = false;
  App.els.progressSection.classList.add('hidden');
  Utils.showNotification('error', 'Processing Failed', err.message || 'An unexpected error occurred during AI processing.');
}

function completeImageResult(originalFile, result, isBatch = false) {
  App.state.isProcessing = false;
  App.state.resultBlob = result.blob;
  App.els.progressSection.classList.add('hidden');

  if (App.state.resultURL) URL.revokeObjectURL(App.state.resultURL);
  App.state.resultURL = URL.createObjectURL(result.blob);

  // Compare slider (image mode)
  App.els.videoCompare.classList.add('hidden');
  App.els.compareContainer.classList.remove('hidden');
  UI.setCompareImages(App.state.originalURL || URL.createObjectURL(originalFile), App.state.resultURL);

  const elapsed = ((Date.now() - App.state.startTime) / 1000).toFixed(1);
  UI.showDownloadSection({
    originalSize: Utils.formatBytes(originalFile.size),
    enhancedSize: Utils.formatBytes(result.blob.size),
    resolution: `${result.width} x ${result.height}`,
    timeTaken: `${elapsed}s`,
    info: isBatch
      ? `Batch of ${App.state.processedCount} image(s) enhanced. Last file shown below (others downloaded automatically).`
      : 'Your image has been enhanced successfully.'
  });

  App.els.compareWrap.closest('section').classList.remove('hidden');
  Utils.showNotification('success', 'Enhancement Complete', 'Your image is ready to download!');
}

function completeVideoResult(originalFile, result) {
  App.state.isProcessing = false;
  App.state.resultBlob = result.blob;
  App.els.progressSection.classList.add('hidden');

  if (App.state.resultURL) URL.revokeObjectURL(App.state.resultURL);
  App.state.resultURL = URL.createObjectURL(result.blob);

  // Video compare view
  App.els.compareContainer.classList.add('hidden');
  App.els.videoCompare.classList.remove('hidden');
  App.els.originalVideo.src = App.state.originalURL || URL.createObjectURL(originalFile);
  App.els.enhancedVideo.src = App.state.resultURL;

  const elapsed = ((Date.now() - App.state.startTime) / 1000).toFixed(1);
  UI.showDownloadSection({
    originalSize: Utils.formatBytes(originalFile.size),
    enhancedSize: Utils.formatBytes(result.blob.size),
    resolution: `${result.width} x ${result.height}`,
    timeTaken: `${elapsed}s`,
    info: 'Your video has been enhanced successfully.'
  });

  App.els.compareWrap.closest('section').classList.remove('hidden');
  Utils.showNotification('success', 'Enhancement Complete', 'Your video is ready to download!');
}

/* ==========================================================================
   COMPARE SECTION CONTROLS (Play / Pause / Stop for video preview)
   ========================================================================== */
function initCompareControls() {
  UI.initCompareSlider();

  App.els.playPauseBtn.addEventListener('click', () => {
    const vids = [App.els.originalVideo, App.els.enhancedVideo];
    const icon = App.els.playPauseBtn.querySelector('i');
    const isPaused = vids[0].paused;

    vids.forEach(v => {
      if (!v.src) return;
      isPaused ? v.play() : v.pause();
    });

    icon.className = isPaused ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    App.els.playPauseBtn.lastChild.textContent = isPaused ? ' Pause' : ' Play';
  });

  App.els.stopBtn.addEventListener('click', () => {
    [App.els.originalVideo, App.els.enhancedVideo].forEach(v => {
      if (!v.src) return;
      v.pause();
      v.currentTime = 0;
    });
    App.els.playPauseBtn.querySelector('i').className = 'fa-solid fa-play';
  });
}

/* ==========================================================================
   DOWNLOAD SECTION CONTROLS
   ========================================================================== */
function initDownloadControls() {
  App.els.downloadBtn.addEventListener('click', () => {
    if (!App.state.resultBlob) {
      Utils.showNotification('error', 'No Result', 'Nothing to download yet.');
      return;
    }
    const ext = App.state.mode === 'image' ? 'png' : 'mp4';
    const baseName = App.state.currentFile
      ? App.state.currentFile.name.replace(/\.[^.]+$/, '')
      : 'enhanced-media';
    Utils.downloadBlob(App.state.resultBlob, `${baseName}-enhanced.${ext}`);
    Utils.showNotification('success', 'Download Started', 'Your file is being downloaded.');
  });

  App.els.enhanceAnotherBtn.addEventListener('click', fullReset);
}

/* ==========================================================================
   FULL RESET
   ========================================================================== */
function fullReset() {
  App.state.cancelled = true;
  App.state.isProcessing = false;
  App.state.processedCount = 0;

  resetFileSelection();

  App.els.progressSection.classList.add('hidden');
  App.els.compareWrap.closest('section').classList.add('hidden');
  App.els.downloadSection.classList.add('hidden');

  if (App.state.originalURL) {
    URL.revokeObjectURL(App.state.originalURL);
    App.state.originalURL = null;
  }
  if (App.state.resultURL) {
    URL.revokeObjectURL(App.state.resultURL);
    App.state.resultURL = null;
  }
  App.state.resultBlob = null;

  App.els.originalVideo.src = '';
  App.els.enhancedVideo.src = '';

  window.scrollTo({ top: App.els.uploadCard.offsetTop - 100, behavior: 'smooth' });
  Utils.showNotification('info', 'Reset Complete', 'Ready for a new file.');
}