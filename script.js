/* ==========================================================================
   AI VIDEO ENHANCER — MAIN APPLICATION SCRIPT (script.js)
   This is the central orchestrator. It wires up every button, manages
   global app state, and calls into the module files:
   js/utils.js  -> Utils.*      (helpers: notifications, formatting, files)
   js/onnx.js   -> ONNXEngine.* (ONNX Runtime Web / GPU detection / model)
   js/image.js  -> ImageProcessor.* (Real-ESRGAN image upscaling pipeline)
   js/video.js  -> VideoProcessor.* (FFmpeg.wasm video pipeline)
   js/ui.js     -> UI.*          (DOM rendering / progress / compare slider)

   DEBUG MODE: This version includes an on-screen Debug Panel that shows
   every step, warning, and error directly on the website — no need to
   open browser DevTools. Tap the bug icon (bottom-right) to open/close it.
   ========================================================================== */

'use strict';

/* ==========================================================================
   ON-SCREEN DEBUG PANEL
   Shows every log/warning/error live on the page itself.
   ========================================================================== */
const DebugPanel = {
  logs: [],
  maxLogs: 200,
  panelEl: null,
  listEl: null,
  isOpen: false,

  init() {
    // Floating toggle button (bug icon)
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'debugToggleBtn';
    toggleBtn.innerHTML = '🐞';
    toggleBtn.style.cssText = `
      position: fixed; bottom: 18px; right: 18px; z-index: 99999;
      width: 50px; height: 50px; border-radius: 50%;
      background: linear-gradient(135deg, #7c5cff, #00e5c9);
      color: #fff; font-size: 22px; border: none; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      display: flex; align-items: center; justify-content: center;
    `;
    document.body.appendChild(toggleBtn);

    // Debug panel container
    const panel = document.createElement('div');
    panel.id = 'debugPanel';
    panel.style.cssText = `
      position: fixed; bottom: 78px; right: 18px; z-index: 99998;
      width: min(94vw, 420px); height: 45vh; max-height: 500px;
      background: rgba(10, 12, 22, 0.97); border: 1px solid rgba(255,255,255,0.15);
      border-radius: 16px; padding: 12px; overflow: hidden;
      display: none; flex-direction: column; font-family: monospace;
      backdrop-filter: blur(10px); box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    `;
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-shrink:0;">
        <strong style="color:#00e5c9; font-size:13px;">🐞 DEBUG LOG (Live)</strong>
        <div>
          <button id="debugClearBtn" style="background:rgba(255,255,255,0.1); border:none; color:#fff; border-radius:6px; padding:4px 8px; font-size:11px; margin-right:6px; cursor:pointer;">Clear</button>
          <button id="debugCloseBtn" style="background:rgba(255,92,122,0.2); border:none; color:#ff5c7a; border-radius:6px; padding:4px 8px; font-size:11px; cursor:pointer;">Close</button>
        </div>
      </div>
      <div id="debugList" style="flex:1; overflow-y:auto; font-size:11px; line-height:1.5; color:#d0d5e8;"></div>
    `;
    document.body.appendChild(panel);

    this.panelEl = panel;
    this.listEl = document.getElementById('debugList');

    toggleBtn.addEventListener('click', () => this.toggle());
    document.getElementById('debugCloseBtn').addEventListener('click', () => this.toggle(false));
    document.getElementById('debugClearBtn').addEventListener('click', () => {
      this.logs = [];
      this.render();
    });

    this.log('info', 'Debug panel initialized. Waiting for actions...');
  },

  toggle(force) {
    this.isOpen = typeof force === 'boolean' ? force : !this.isOpen;
    this.panelEl.style.display = this.isOpen ? 'flex' : 'none';
  },

  log(level, message) {
    const time = new Date().toLocaleTimeString();
    this.logs.push({ level, message, time });
    if (this.logs.length > this.maxLogs) this.logs.shift();
    this.render();

    // Auto-open panel automatically whenever a real error happens
    if (level === 'error') {
      this.toggle(true);
    }

    // Mirror to real console too, for anyone who does have DevTools open
    if (level === 'error') console.error(`[${time}]`, message);
    else if (level === 'warn') console.warn(`[${time}]`, message);
    else console.log(`[${time}]`, message);
  },

  render() {
    if (!this.listEl) return;
    const colors = { info: '#5b8cff', warn: '#ffb547', error: '#ff5c7a', success: '#33d69f' };
    this.listEl.innerHTML = this.logs.map(l => `
      <div style="padding:4px 6px; border-left:2px solid ${colors[l.level] || '#5b8cff'}; margin-bottom:4px; background:rgba(255,255,255,0.03); border-radius:4px;">
        <span style="color:${colors[l.level] || '#5b8cff'}; font-weight:bold;">[${l.time}]</span>
        <span style="color:#e8ebf7; word-break:break-word;"> ${this._escape(l.message)}</span>
      </div>
    `).join('');
    this.listEl.scrollTop = this.listEl.scrollHeight;
  },

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
};

// Catch every uncaught JS error, no matter how small, and show it on screen
window.addEventListener('error', (e) => {
  DebugPanel.log('error', `Uncaught Error: ${e.message} (at ${e.filename}:${e.lineno}:${e.colno})`);
});

// Catch every unhandled promise rejection (most async/fetch errors land here)
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  DebugPanel.log('error', `Unhandled Promise Rejection: ${reason}`);
});

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
  DebugPanel.init();
  DebugPanel.log('info', 'DOM fully loaded. Starting app initialization...');

  try {
    cacheElements();
    DebugPanel.log('success', 'DOM elements cached successfully.');

    UI.initTheme();
    UI.initNavbarScroll();
    UI.initMobileDrawer();
    UI.initScrollSpy();
    UI.initModal();
    DebugPanel.log('success', 'UI module initialized.');

    initModeSwitch();
    initUploadArea();
    initSettingsPanel();
    initActionButtons();
    initCompareControls();
    initDownloadControls();
    DebugPanel.log('success', 'All buttons and controls wired up.');

    setYear();
    detectSystemCapabilities();
  } catch (err) {
    DebugPanel.log('error', `Initialization failed: ${err.message}`);
  }
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
  ids.forEach(id => {
    App.els[id] = document.getElementById(id);
    if (!App.els[id]) {
      DebugPanel.log('warn', `Element with id "${id}" not found in HTML.`);
    }
  });
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
  DebugPanel.log('info', 'Detecting GPU / WebGPU capability...');
  try {
    const gpuInfo = await ONNXEngine.detectGPU();
    DebugPanel.log(gpuInfo.available ? 'success' : 'warn', `GPU detection result: ${JSON.stringify(gpuInfo)}`);

    App.els.gpuStatus.textContent = gpuInfo.available ? gpuInfo.name : 'Not Available';
    App.els.backendStatus.textContent = gpuInfo.available ? 'WebGPU Ready' : 'WASM Only';
    App.els.modelStatus.textContent = 'Idle (Not Loaded)';

    if (!gpuInfo.available) {
      App.els.backendSelect.value = 'wasm';
      App.settings.backend = 'wasm';
      const opt = App.els.backendSelect.querySelector('option[value="webgpu"]');
      if (opt) opt.disabled = true;
    }
  } catch (err) {
    DebugPanel.log('error', `GPU detection threw an error: ${err.message}`);
  }

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

  DebugPanel.log('info', `Switching mode to: ${mode}`);
  App.state.mode = mode;
  App.els.imageModeBtn.classList.toggle('active', mode === 'image');
  App.els.videoModeBtn.classList.toggle('active', mode === 'video');

  if (mode === 'image') {
    App.els.fileInput.accept = 'image/*';
    App.els.uploadHint.textContent = 'Supported: JPG, PNG, WEBP (Max 25MB)';
  } else {
    App.els.fileInput.accept = 'video/*';
    App.els.uploadHint.textContent = 'Supported: MP4, WEBM, MOV (Max 100MB)';
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
    DebugPanel.log('info', `File input changed. ${e.target.files.length} file(s) selected.`);
    handleIncomingFiles(Array.from(e.target.files));
  });

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
    DebugPanel.log('info', `File(s) dropped: ${e.dataTransfer.files.length}`);
    const files = Array.from(e.dataTransfer.files);
    handleIncomingFiles(files);
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target === browseBtn || browseBtn.contains(e.target)) return;
    fileInput.click();
  });
}

function handleIncomingFiles(files) {
  if (!files || files.length === 0) return;

  const expectedType = App.state.mode === 'image' ? 'image' : 'video';
  const maxSizeMB = App.state.mode === 'image' ? 25 : 100;

  const validFiles = [];
  for (const file of files) {
    const validation = Utils.validateFile(file, expectedType, maxSizeMB);
    if (!validation.valid) {
      DebugPanel.log('warn', `File rejected: ${file.name} — ${validation.message}`);
      Utils.showNotification('error', 'Invalid File', validation.message);
      continue;
    }
    validFiles.push(file);
  }

  if (validFiles.length === 0) return;

  if (App.settings.batchMode && App.state.mode === 'image') {
    validFiles.forEach(file => addToBatchQueue(file));
    Utils.showNotification('success', 'Files Added', `${validFiles.length} file(s) added to batch queue.`);
  } else {
    setCurrentFile(validFiles[0]);
  }
}

function setCurrentFile(file) {
  DebugPanel.log('success', `File selected: ${file.name} (${Utils.formatBytes(file.size)}, type: ${file.type})`);
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
  DebugPanel.log('info', `Added to batch queue: ${file.name}`);
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
    DebugPanel.log('info', `Scale changed to: ${App.settings.scale}x`);
  });

  App.els.tileSelect.addEventListener('change', (e) => {
    App.settings.tileSize = parseInt(e.target.value, 10);
    DebugPanel.log('info', `Tile size changed to: ${App.settings.tileSize}px`);
  });

  App.els.backendSelect.addEventListener('change', (e) => {
    App.settings.backend = e.target.value;
    DebugPanel.log('info', `Backend changed to: ${App.settings.backend}`);
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

    if (!e.target.checked) {
      App.state.batchQueue = [];
      UI.renderBatchList([], removeFromBatchQueue);
      App.els.batchList.classList.add('hidden');
    } else if (App.state.currentFile) {
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

  DebugPanel.log('info', `Enhance button clicked. Mode: ${App.state.mode}, Batch: ${App.settings.batchMode}`);
  DebugPanel.log('info', `Settings: ${JSON.stringify(App.settings)}`);

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
  DebugPanel.log('info', `Starting single image pipeline for: ${file.name}`);

  try {
    await ensureModelLoaded();

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(30, 'Preprocessing image...');
    DebugPanel.log('info', 'Model loaded. Starting image upscale...');

    const result = await ImageProcessor.upscaleImage(file, App.settings, (pct, stage) => {
      const mapped = 30 + Math.round(pct * 0.65);
      UI.updateProgress(mapped, stage);
      DebugPanel.log('info', `[${mapped}%] ${stage}`);
    }, () => App.state.cancelled);

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Finalizing output...');
    DebugPanel.log('success', 'Image upscale finished successfully.');
    completeImageResult(file, result);
  } catch (err) {
    DebugPanel.log('error', `Image pipeline failed: ${err.message}\n${err.stack || ''}`);
    handleProcessingError(err);
  }
}

/* ---------------- BATCH IMAGE PIPELINE ---------------- */
async function runBatchImagePipeline() {
  beginProcessing('Processing Batch', 'Loading AI model...');
  DebugPanel.log('info', `Starting batch pipeline with ${App.state.batchQueue.length} files.`);

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
      DebugPanel.log('info', `Processing batch item: ${item.file.name}`);

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
      DebugPanel.log('success', `Batch item done: ${item.file.name}`);
    }

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Batch complete!');
    await Utils.downloadBlob(lastResult.blob, `enhanced-${lastFile.name.replace(/\.[^.]+$/, '')}.png`);
    completeImageResult(lastFile, lastResult, true);
  } catch (err) {
    DebugPanel.log('error', `Batch pipeline failed: ${err.message}\n${err.stack || ''}`);
    handleProcessingError(err);
  }
}

/* ---------------- VIDEO PIPELINE ---------------- */
async function runVideoPipeline(file) {
  beginProcessing('Enhancing Video', 'Loading FFmpeg engine...');
  DebugPanel.log('info', `Starting video pipeline for: ${file.name}`);

  try {
    await ensureModelLoaded();

    await VideoProcessor.loadFFmpeg((pct, stage) => {
      UI.updateProgress(Math.round(pct * 0.1), stage);
      DebugPanel.log('info', `[FFmpeg Load ${pct}%] ${stage}`);
    });

    if (App.state.cancelled) return finishCancelled();

    const result = await VideoProcessor.processVideo(file, App.settings, (pct, stage) => {
      const mapped = 10 + Math.round(pct * 0.9);
      UI.updateProgress(mapped, stage);
      DebugPanel.log('info', `[${mapped}%] ${stage}`);
    }, () => App.state.cancelled);

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(100, 'Video ready!');
    DebugPanel.log('success', 'Video pipeline finished successfully.');
    completeVideoResult(file, result);
  } catch (err) {
    DebugPanel.log('error', `Video pipeline failed: ${err.message}\n${err.stack || ''}`);
    handleProcessingError(err);
  }
}

/* ---------------- SHARED HELPERS ---------------- */
async function ensureModelLoaded() {
  if (ONNXEngine.isLoaded) {
    UI.updateProgress(25, 'AI model already loaded, reusing session...');
    DebugPanel.log('info', 'Model already loaded — reusing existing session.');
    return;
  }

  App.els.modelStatus.textContent = 'Loading...';
  
  // Directly injecting the release download URL as requested
  const MODEL_OVERRIDE_PATH = 'https://cdn.jsdelivr.net/gh/thebolbm-oss/ai-video-enhancer@main/models/realesrgan-x4.onnx';
   
  if (typeof ONNXEngine.setModelPath === 'function') {
    ONNXEngine.setModelPath(MODEL_OVERRIDE_PATH);
  } else {
    ONNXEngine.MODEL_PATH = MODEL_OVERRIDE_PATH;
  }

  DebugPanel.log('info', `Attempting to fetch model from: ${ONNXEngine.MODEL_PATH}`);

  try {
    await ONNXEngine.init(App.settings.backend);
    DebugPanel.log('success', `ONNX Runtime environment initialized. Preferred backend: ${App.settings.backend}`);

    await ONNXEngine.loadModel((pct, stage) => {
      UI.updateProgress(Math.round(pct * 0.25), stage);
      DebugPanel.log('info', `[Model Load ${pct}%] ${stage}`);
    });

    App.els.modelStatus.textContent = 'Loaded & Ready';
    App.els.backendStatus.textContent = ONNXEngine.activeBackend === 'webgpu' ? 'WebGPU Active' : 'WASM Active';
    DebugPanel.log('success', `Model loaded successfully using ${ONNXEngine.activeBackend.toUpperCase()} backend.`);

  } catch (err) {
    App.els.modelStatus.textContent = 'Failed to Load';
    DebugPanel.log('error', `MODEL LOAD FAILED: ${err.message}`);
    DebugPanel.log('error', `Full error object: ${err.stack || JSON.stringify(err)}`);
    DebugPanel.log('warn', 'Common causes: (1) CORS block on the model URL, (2) mobile network blocking large file fetch, (3) URL typo, (4) GitHub release still propagating — wait a few minutes and retry.');

    throw new Error(
      `AI model failed to download. Reason: "${err.message}". ` +
      `Check the debug panel (bug icon, bottom-right) for full details. ` +
      `Try switching between WiFi and mobile data, then tap Enhance again.`
    );
  }
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
  DebugPanel.log('warn', 'User requested cancellation.');
  Utils.showNotification('warning', 'Cancelling...', 'Stopping the current process, please wait.');
}

function finishCancelled() {
  App.state.isProcessing = false;
  App.els.enhanceBtn.disabled = false;
  App.els.progressSection.classList.add('hidden');
  DebugPanel.log('info', 'Processing cancelled successfully.');
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
  DebugPanel.log('info', 'App reset to default state.');
  Utils.showNotification('info', 'Reset Complete', 'Ready for a new file.');
}
