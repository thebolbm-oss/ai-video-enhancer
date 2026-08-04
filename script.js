/* ==========================================================================
   AI VIDEO ENHANCER — MAIN APPLICATION SCRIPT (script.js)
   ========================================================================== */

'use strict';

/* ==========================================================================
   ON-SCREEN DEBUG PANEL
   ========================================================================== */
const DebugPanel = {
  logs: [],
  maxLogs: 200,
  panelEl: null,
  listEl: null,
  isOpen: false,

  init() {
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

    if (level === 'error') {
      this.toggle(true);
    }

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

window.addEventListener('error', (e) => {
  DebugPanel.log('error', `Uncaught Error: ${e.message} (at ${e.filename}:${e.lineno}:${e.colno})`);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  DebugPanel.log('error', `Unhandled Promise Rejection: ${reason}`);
});

/* ==========================================================================
   GLOBAL APPLICATION STATE
   ========================================================================== */
const App = {
  state: {
    mode: 'image',
    currentFile: null,
    batchQueue: [],
    isProcessing: false,
    cancelled: false,
    resultBlob: null,
    resultURL: null,
    originalURL: null,
    startTime: null,
    processedCount: 0
  },

  settings: {
    scale: 4,
    tileSize: 256,
    backend: 'webgpu',
    faceEnhance: false,
    denoise: true,
    sharpen: false,
    edgeEnhance: false,
    textureEnhance: false,
    boostMode: false,
    videoFps: 0, // 0 = auto (duration-based)
    batchMode: false
  },

  els: {}
};

/* ==========================================================================
   INITIALIZATION
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
    initModelSetup();
    initVideoEngineSetup();
    initBoostMode();
    initBackendSlider();
    initTargetResMode();
    DebugPanel.log('success', 'All buttons and controls wired up.');

    setYear();
    detectSystemCapabilities();
  } catch (err) {
    DebugPanel.log('error', `Initialization failed: ${err.message}`);
  }
});

function cacheElements() {
  const ids = [
    'fileInput', 'dropZone', 'uploadCard', 'browseBtn', 'uploadHint',
    'imageModeBtn', 'videoModeBtn',
    'scaleSelect', 'tileSelect', 'backendSelect',
    'faceEnhanceToggle', 'denoiseToggle', 'batchToggle',
    'videoFpsSelect', 'videoFpsSetting',
    'sharpenToggle', 'edgeEnhanceToggle', 'textureEnhanceToggle',
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
    'loadingOverlay', 'loadingText', 'currentYear',
    // Model setup section (lite model only now)
    'modelSetupProgress', 'modelProgressBarInner', 'modelProgressText',
    'modelSetupStatus', 'useLiteModelBtn',
    'backendSlider', 'backendSliderLabel',
    // Fast Mode
    'fastModeBtn',
    // WebGPU Boost Mode
    'boostModeCard', 'boostModeBtn', 'boostModeBtnText', 'boostModeIcon', 'boostActiveBadge',
    // Target Resolution Mode
    'targetResPresets', 'targetResInput', 'targetResPreview', 'targetResBtn',
    // Video engine setup (ffmpeg-core.wasm download + upload + cache)
    'wasmDownloadLink', 'wasmFileInput', 'wasmUploadBtn',
    'wasmSetupProgress', 'wasmProgressBarInner', 'wasmProgressText',
    'wasmSetupStatus', 'wasmClearBtn'
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
   SYSTEM CAPABILITY DETECTION
   ========================================================================== */
async function detectSystemCapabilities() {
  DebugPanel.log(
    window.crossOriginIsolated ? 'success' : 'warn',
    `Cross-origin isolation: ${window.crossOriginIsolated ? 'ACTIVE (multi-threaded WASM available, up to ' + (navigator.hardwareConcurrency || 4) + ' cores)' : 'not active yet (single-threaded WASM — may enable after a reload)'}`
  );

  DebugPanel.log('info', 'Detecting GPU / WebGPU capability...');
  try {
    const gpuInfo = await ONNXEngine.detectGPU();
    DebugPanel.log(gpuInfo.available ? 'success' : 'warn', `GPU detection result: ${JSON.stringify(gpuInfo)}`);

    App.els.gpuStatus.textContent = gpuInfo.available ? gpuInfo.name : 'Not Available';
    App.els.backendStatus.textContent = gpuInfo.available ? 'WebGPU Detected (Idle)' : 'CPU Only (No WebGPU)';
    if (!ONNXEngine.isLoaded) {
      App.els.modelStatus.textContent = 'Idle (Not Loaded)';
    }

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
   CPU <-> WEBGPU FORCE SLIDER
   Left (0) = force CPU (WASM) only. Right (1) = force WebGPU only, no
   fallback. Changing this while a model is already loaded disposes the
   current session(s) and reloads fresh with the new forced backend.
   ========================================================================== */
function initBackendSlider() {
  if (!App.els.backendSlider) return;

  App.els.backendSlider.addEventListener('input', async () => {
    const isWebGPU = App.els.backendSlider.value === '1';
    ONNXEngine.forcedBackend = isWebGPU ? 'webgpu' : 'cpu';

    if (App.els.backendSliderLabel) {
      App.els.backendSliderLabel.textContent = isWebGPU
        ? '⚡ WebGPU Force (GPU Full Power)'
        : '🖥️ CPU Only (WASM, No GPU)';
    }

    DebugPanel.log('info', `Backend slider moved: forcing ${isWebGPU ? 'WebGPU only' : 'CPU (WASM) only'}. Reloading model...`);

    if (App.state.isProcessing) {
      Utils.showNotification('warning', 'Processing Active', 'Naya backend agli enhancement se apply hoga.');
      return;
    }

    // Reload the model fresh with the newly forced backend
    await ONNXEngine.dispose();
    ONNXEngine.sessionPool = [];
    App.els.modelStatus.textContent = 'Idle (Not Loaded)';
    App.els.enhanceBtn.disabled = true;
    updateFastModeButtonState();

    await runLiteModelLoad({ showToast: true });
  });
}

/* ==========================================================================
   WEBGPU BOOST MODE — toggles concurrent tile processing (real: multiple
   AI inference calls in flight at once instead of strictly one-by-one),
   with a visible pulsing animation on the card and a fixed corner badge
   while it's active.
   ========================================================================== */
function initBoostMode() {
  if (!App.els.boostModeBtn) return;

  App.els.boostModeBtn.addEventListener('click', () => {
    App.settings.boostMode = !App.settings.boostMode;
    applyBoostModeUI();
    DebugPanel.log('info', `WebGPU Boost Mode ${App.settings.boostMode ? 'ENABLED (concurrent tile processing)' : 'disabled'}.`);
    Utils.showNotification(
      App.settings.boostMode ? 'success' : 'info',
      App.settings.boostMode ? 'Boost Mode ON' : 'Boost Mode OFF',
      App.settings.boostMode
        ? 'Ab tiles parallel me process honge — zyada RAM/CPU use hoga.'
        : 'Normal (one-at-a-time) processing wapas ho gaya.'
    );
  });

  applyBoostModeUI();
}

function applyBoostModeUI() {
  const active = App.settings.boostMode;

  if (App.els.boostModeCard) App.els.boostModeCard.classList.toggle('active', active);
  if (App.els.boostModeBtnText) App.els.boostModeBtnText.textContent = active ? 'Boost Mode: ON' : 'Boost Mode: OFF';
  if (App.els.boostActiveBadge) App.els.boostActiveBadge.classList.toggle('hidden', !active);
}

/* ==========================================================================
   AI MODEL SETUP — Lite model only (auto-preloaded on page load)
   ========================================================================== */
async function initModelSetup() {
  if (!App.els.useLiteModelBtn) {
    DebugPanel.log('warn', 'Model setup elements missing — skipping model setup init.');
    return;
  }

  App.els.useLiteModelBtn.addEventListener('click', async () => {
    if (App.state.isProcessing) {
      Utils.showNotification('warning', 'Processing Active', 'Please wait for current process to finish.');
      return;
    }
    await runLiteModelLoad({ showToast: true });
  });

  // AUTO-PRELOAD: start loading the bundled lite model in the background
  // as soon as the page opens — the person doesn't have to click anything.
  DebugPanel.log('info', 'Auto-preloading lite model in the background...');
  runLiteModelLoad({ showToast: false });
}

/* ------------------------------------------------------------------
   SHARED LITE MODEL LOADER — used by both the "Use Lite Model" button
   and the automatic background preload on page open.
   ------------------------------------------------------------------ */
async function runLiteModelLoad({ showToast = true } = {}) {
  if (ONNXEngine.isLoaded && ONNXEngine.activeModelType === 'lite') {
    return; // already loaded, nothing to do
  }

  if (ONNXEngine.isLoading) {
    return; // a load is already in progress (e.g. auto-preload) — don't start another
  }

  if (App.els.useLiteModelBtn) App.els.useLiteModelBtn.disabled = true;

  App.els.modelSetupProgress.classList.remove('hidden');
  App.els.modelStatus.textContent = 'Loading...';
  updateModelStatus('info', 'Lite model load ho raha hai (background me)...');
  DebugPanel.log('info', 'Loading lite model (bundled in repo, no download needed).');

  try {
    await ONNXEngine.init(App.settings.backend);
    await ONNXEngine.loadLiteModel((pct, stage) => updateModelProgress(pct, stage));
    onModelReady();
    if (showToast) {
      Utils.showNotification('success', 'Lite Model Ready', 'Turant use karo!');
    }
    DebugPanel.log('success', 'Lite model loaded successfully.');
  } catch (err) {
    DebugPanel.log('error', `Lite model load failed: ${err.message}`);
    updateModelStatus('error', `Load fail hua: ${err.message}`);
    App.els.modelStatus.textContent = 'Failed to Load';
    App.els.modelSetupProgress.classList.add('hidden');
    if (showToast) {
      Utils.showNotification('error', 'Lite Model Failed', err.message);
    }
  } finally {
    if (App.els.useLiteModelBtn) App.els.useLiteModelBtn.disabled = false;
  }
}

function updateModelProgress(pct, stage) {
  if (App.els.modelProgressBarInner) {
    App.els.modelProgressBarInner.style.width = `${pct}%`;
  }
  if (App.els.modelProgressText) {
    App.els.modelProgressText.textContent = `${pct}% — ${stage}`;
  }
}

function onModelReady() {
  App.els.modelSetupProgress.classList.add('hidden');
  updateModelStatus('success', 'Lite Model ready hai — ab "Enhance Now" ya "Fast Mode" use kar sakte ho.');
  App.els.modelStatus.textContent = 'Loaded & Ready (Lite Model)';
  App.els.backendStatus.textContent = ONNXEngine.activeBackend === 'webgpu' ? 'WebGPU Active' : 'WASM Active';
  App.els.enhanceBtn.disabled = !App.state.currentFile && App.state.batchQueue.length === 0;
  updateFastModeButtonState();
}

/* ------------------------------------------------------------------
   FAST MODE button is only enabled when: model is loaded, a single
   image file is selected (not batch, not video — Fast Mode is
   images-only for now), and nothing else is currently processing.
   ------------------------------------------------------------------ */
function updateFastModeButtonState() {
  if (!App.els.fastModeBtn) return;
  const ready = ONNXEngine.isLoaded
    && App.state.mode === 'image'
    && !!App.state.currentFile
    && !App.state.isProcessing;
  App.els.fastModeBtn.disabled = !ready;

  updateTargetResButtonState();
}

function updateTargetResButtonState() {
  if (!App.els.targetResBtn) return;
  const ready = ONNXEngine.isLoaded
    && !!App.state.currentFile
    && !App.state.isProcessing;
  App.els.targetResBtn.disabled = !ready;
  refreshTargetResPreview();
}

function updateModelStatus(type, text) {
  if (!App.els.modelSetupStatus) return;
  const icons = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warn: 'fa-triangle-exclamation',
    error: 'fa-circle-exclamation'
  };
  App.els.modelSetupStatus.className = `model-setup-status ${type}`;
  App.els.modelSetupStatus.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i> ${Utils.escapeHTML(text)}`;
}

/* ==========================================================================
   VIDEO ENGINE SETUP (ffmpeg-core.wasm Download + Local Upload + Cache)
   Same pattern as the AI model setup above — needed because this ~32MB
   file is too big for GitHub's web "Upload files" UI (25MB cap), so it's
   never committed to the repo. It's downloaded once by the user and
   uploaded through this section instead, then cached in the browser.
   ========================================================================== */
async function initVideoEngineSetup() {
  if (!App.els.wasmUploadBtn || !App.els.wasmFileInput) {
    DebugPanel.log('warn', 'Video engine setup elements missing — skipping init.');
    return;
  }

  if (App.els.wasmDownloadLink) {
    App.els.wasmDownloadLink.href = VideoProcessor.WASM_DOWNLOAD_URL;
  }

  App.els.wasmUploadBtn.addEventListener('click', () => App.els.wasmFileInput.click());

  App.els.wasmFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.wasm')) {
      Utils.showNotification('error', 'Galat File', 'Sirf ffmpeg-core.wasm file select karo.');
      DebugPanel.log('warn', `Rejected non-.wasm file: ${file.name}`);
      return;
    }

    App.els.wasmSetupProgress.classList.remove('hidden');
    updateWasmStatus('info', `"${file.name}" load ho raha hai...`);
    DebugPanel.log('info', `Loading ffmpeg-core.wasm from uploaded file: ${file.name} (${Utils.formatBytes(file.size)})`);

    try {
      await VideoProcessor.loadWasmFromFile(file, (pct, stage) => updateWasmProgress(pct, stage));
      onWasmReady();
      Utils.showNotification('success', 'Video Engine Ready', 'Ab video enhance kar sakte ho — agli baar upload nahi karna padega.');
      DebugPanel.log('success', 'ffmpeg-core.wasm loaded from upload and cached successfully.');
    } catch (err) {
      DebugPanel.log('error', `Video engine load failed: ${err.message}`);
      updateWasmStatus('error', `Load fail hua: ${err.message}`);
      App.els.wasmSetupProgress.classList.add('hidden');
      Utils.showNotification('error', 'Video Engine Failed', err.message);
    }
  });

  if (App.els.wasmClearBtn) {
    App.els.wasmClearBtn.addEventListener('click', async () => {
      await VideoProcessor.clearCachedWasm();
      App.els.wasmFileInput.value = '';
      updateWasmStatus('info', 'Saved video engine clear kar diya gaya. Dobara upload karo.');
      Utils.showNotification('info', 'Video Engine Cleared', 'Cached ffmpeg-core.wasm hata diya gaya hai.');
      DebugPanel.log('info', 'Cached ffmpeg-core.wasm cleared by user.');
    });
  }

  // On startup, check if the wasm was already uploaded + cached previously
  DebugPanel.log('info', 'Checking for a previously cached video engine...');
  const hasCached = await VideoProcessor.checkCachedWasm();

  if (hasCached) {
    updateWasmStatus('info', 'Saved video engine mila — load ho raha hai...');
    App.els.wasmSetupProgress.classList.remove('hidden');

    try {
      await VideoProcessor.loadWasmFromCache((pct, stage) => updateWasmProgress(pct, stage));
      onWasmReady();
      DebugPanel.log('success', 'Cached ffmpeg-core.wasm auto-loaded successfully.');
    } catch (err) {
      DebugPanel.log('warn', `Cached video engine load failed: ${err.message}`);
      updateWasmStatus('warn', 'Saved video engine load nahi ho paaya. Dobara upload karo.');
      App.els.wasmSetupProgress.classList.add('hidden');
    }
  } else {
    updateWasmStatus('info', 'Video enhance karne se pehle ye setup karo — image ke liye skip kar sakte ho.');
  }
}

function updateWasmProgress(pct, stage) {
  if (App.els.wasmProgressBarInner) {
    App.els.wasmProgressBarInner.style.width = `${pct}%`;
  }
  if (App.els.wasmProgressText) {
    App.els.wasmProgressText.textContent = `${pct}% — ${stage}`;
  }
}

function onWasmReady() {
  App.els.wasmSetupProgress.classList.add('hidden');
  updateWasmStatus('success', 'Video engine ready hai — ab video enhance kar sakte ho.');
}

function updateWasmStatus(type, text) {
  if (!App.els.wasmSetupStatus) return;
  const icons = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warn: 'fa-triangle-exclamation',
    error: 'fa-circle-exclamation'
  };
  App.els.wasmSetupStatus.className = `model-setup-status ${type}`;
  App.els.wasmSetupStatus.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i> ${Utils.escapeHTML(text)}`;
}

/* ==========================================================================
   MODE SWITCH
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
    if (App.els.videoFpsSetting) App.els.videoFpsSetting.classList.add('hidden');
  } else {
    App.els.fileInput.accept = 'video/*';
    App.els.uploadHint.textContent = 'Supported: MP4, WEBM, MOV (Max 400MB)';
    App.els.batchToggle.checked = false;
    App.settings.batchMode = false;
    App.els.batchList.classList.add('hidden');
    if (App.els.videoFpsSetting) App.els.videoFpsSetting.classList.remove('hidden');
  }

  resetFileSelection();
}

/* ==========================================================================
   UPLOAD AREA
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
  const maxSizeMB = App.state.mode === 'image' ? 25 : 400;

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
  App.els.enhanceBtn.disabled = !ONNXEngine.isLoaded;
  updateFastModeButtonState();

  Utils.showNotification('info', 'File Ready', `"${file.name}" loaded successfully.`);

  if (!ONNXEngine.isLoaded) {
    Utils.showNotification('warning', 'Model Load Ho Raha Hai', 'AI model background me load ho raha hai, thoda wait karo.');
  }
}

function removeCurrentFile() {
  App.state.currentFile = null;
  if (App.state.originalURL) {
    URL.revokeObjectURL(App.state.originalURL);
    App.state.originalURL = null;
  }
  App.els.fileInput.value = '';
  App.els.enhanceBtn.disabled = App.state.batchQueue.length === 0 || !ONNXEngine.isLoaded;
  updateFastModeButtonState();
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
  App.els.enhanceBtn.disabled = !ONNXEngine.isLoaded;
  DebugPanel.log('info', `Added to batch queue: ${file.name}`);
}

function removeFromBatchQueue(id) {
  App.state.batchQueue = App.state.batchQueue.filter(item => item.id !== id);
  UI.renderBatchList(App.state.batchQueue, removeFromBatchQueue);
  if (App.state.batchQueue.length === 0) {
    App.els.batchList.classList.add('hidden');
    App.els.enhanceBtn.disabled = !App.state.currentFile || !ONNXEngine.isLoaded;
  }
}

/* ==========================================================================
   AI SETTINGS PANEL
   ========================================================================== */
function initSettingsPanel() {
  App.els.scaleSelect.addEventListener('change', (e) => {
    App.settings.scale = parseInt(e.target.value, 10);
    DebugPanel.log('info', `Scale changed to: ${App.settings.scale}x`);
  });

  if (App.els.videoFpsSelect) {
    App.els.videoFpsSelect.addEventListener('change', (e) => {
      App.settings.videoFps = parseInt(e.target.value, 10) || 0;
      DebugPanel.log('info', `Video extraction FPS set to: ${App.settings.videoFps || 'Auto'}`);
    });
  }

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

  App.els.sharpenToggle.addEventListener('change', (e) => {
    App.settings.sharpen = e.target.checked;
    DebugPanel.log('info', `Sharpen (GPU) ${e.target.checked ? 'enabled' : 'disabled'}.`);
  });

  App.els.edgeEnhanceToggle.addEventListener('change', (e) => {
    App.settings.edgeEnhance = e.target.checked;
    DebugPanel.log('info', `Edge Enhancement (GPU) ${e.target.checked ? 'enabled' : 'disabled'}.`);
  });

  App.els.textureEnhanceToggle.addEventListener('change', (e) => {
    App.settings.textureEnhance = e.target.checked;
    DebugPanel.log('info', `Texture/Clarity Boost ${e.target.checked ? 'enabled' : 'disabled'}.`);
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
   ACTION BUTTONS
   ========================================================================== */
function initActionButtons() {
  App.els.enhanceBtn.addEventListener('click', startEnhancement);
  App.els.resetBtn.addEventListener('click', fullReset);
  App.els.cancelBtn.addEventListener('click', cancelProcessing);

  if (App.els.fastModeBtn) {
    App.els.fastModeBtn.addEventListener('click', startFastModeEnhancement);
  }
}

/* ==========================================================================
   TARGET RESOLUTION MODE — completely separate from manual Enhance and
   Fast Mode. Person specifies an exact output resolution (long-side px)
   instead of a fixed 1x/2x/4x multiplier, and the system computes the
   precise scale needed. Works for both images and video.
   ========================================================================== */
function initTargetResMode() {
  if (!App.els.targetResBtn) return;

  if (App.els.targetResPresets) {
    App.els.targetResPresets.querySelectorAll('.target-res-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        App.els.targetResPresets.querySelectorAll('.target-res-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        App.els.targetResInput.value = btn.dataset.value;
        refreshTargetResPreview();
      });
    });
  }

  if (App.els.targetResInput) {
    App.els.targetResInput.addEventListener('input', () => {
      if (App.els.targetResPresets) {
        App.els.targetResPresets.querySelectorAll('.target-res-preset-btn').forEach(b => b.classList.remove('active'));
      }
      refreshTargetResPreview();
    });
  }

  App.els.targetResBtn.addEventListener('click', startTargetResEnhancement);
}

async function refreshTargetResPreview() {
  if (!App.els.targetResPreview) return;

  if (!App.state.currentFile) {
    App.els.targetResPreview.textContent = 'Koi file select karne ke baad yaha exact scale dikhega.';
    return;
  }

  const target = parseInt(App.els.targetResInput.value, 10) || 2400;

  try {
    let srcLongSide;
    if (App.state.mode === 'image') {
      const dims = await Utils.getImageDimensions(App.state.currentFile);
      srcLongSide = Math.max(dims.width, dims.height);
    } else {
      const meta = await VideoProcessor._getVideoMetadata(App.state.currentFile);
      srcLongSide = Math.max(meta.width, meta.height);
    }

    const rawScale = target / srcLongSide;
    const appliedScale = Utils.clamp(rawScale, App.state.mode === 'image' ? 0.1 : 1, 4);

    if (rawScale > 4.05) {
      App.els.targetResPreview.textContent =
        `Source ${srcLongSide}px hai — ${target}px ke liye ${rawScale.toFixed(2)}x chahiye, lekin ek pass max 4x tak hi ja sakta hai. ` +
        `4x se output ~${Math.round(srcLongSide * 4)}px milega.`;
    } else if (appliedScale <= 1) {
      App.els.targetResPreview.textContent =
        `Source (${srcLongSide}px) already target se bada/barabar hai — AI use nahi hoga, seedha ${target}px tak resize hoga (bahut fast).`;
    } else {
      App.els.targetResPreview.textContent =
        `Source ${srcLongSide}px → Target ${target}px = ${appliedScale.toFixed(3)}x scale (exact, AI utna hi kaam karega jitna zaroori hai).`;
    }
  } catch (e) {
    App.els.targetResPreview.textContent = 'Preview calculate nahi ho paya — enhance karte waqt sahi scale lagega.';
  }
}

async function startTargetResEnhancement() {
  if (App.state.isProcessing) return;

  if (!ONNXEngine.isLoaded) {
    Utils.showNotification('error', 'Model Load Nahi Hua', 'AI model abhi bhi load ho raha hai, thoda wait karo.');
    return;
  }
  if (!App.state.currentFile) {
    Utils.showNotification('error', 'No File', 'Pehle koi image ya video select karo.');
    return;
  }

  const target = parseInt(App.els.targetResInput.value, 10) || 2400;
  const file = App.state.currentFile;
  DebugPanel.log('info', `Target Resolution Mode started for: ${file.name}, target ${target}px`);

  beginProcessing('Target Resolution Mode', `Calculating exact scale for ${target}px...`);

  try {
    if (App.state.mode === 'image') {
      const result = await ImageProcessor.upscaleImageToTarget(file, target, App.settings, (pct, stage) => {
        UI.updateProgress(pct, stage);
        DebugPanel.log('info', `[Target Res ${pct}%] ${stage}`);
      }, () => App.state.cancelled);

      if (App.state.cancelled) return finishCancelled();

      DebugPanel.log('success', `Target Resolution complete. Applied scale: ${result.appliedScale.toFixed(3)}x${result.skippedAI ? ' (AI skipped)' : ''}`);
      completeImageResult(file, result);
    } else {
      await ensureModelLoaded();
      await VideoProcessor.loadFFmpeg((pct, stage) => {
        UI.updateProgress(Math.round(pct * 0.1), stage);
      });

      if (App.state.cancelled) return finishCancelled();

      const result = await VideoProcessor.processVideoToTarget(file, target, App.settings, (pct, stage) => {
        const mapped = 10 + Math.round(pct * 0.9);
        UI.updateProgress(mapped, stage);
        DebugPanel.log('info', `[Target Res ${mapped}%] ${stage}`);
      }, () => App.state.cancelled);

      if (App.state.cancelled) return finishCancelled();

      DebugPanel.log('success', 'Target Resolution video complete.');
      completeVideoResult(file, result);
    }
  } catch (err) {
    DebugPanel.log('error', `Target Resolution Mode failed: ${err.message}\n${err.stack || ''}`);
    handleProcessingError(err);
  }
}


async function startFastModeEnhancement() {
  if (App.state.isProcessing) return;

  if (!ONNXEngine.isLoaded) {
    Utils.showNotification('error', 'Model Load Nahi Hua', 'AI model abhi bhi load ho raha hai, thoda wait karo.');
    return;
  }
  if (!App.state.currentFile) {
    Utils.showNotification('error', 'No File', 'Pehle koi image select karo.');
    return;
  }

  const file = App.state.currentFile;
  DebugPanel.log('info', `Fast Mode enhancement started for: ${file.name}`);

  beginProcessing('Fast Mode — Analyzing & Enhancing', 'Analyzing image quality...');

  try {
    const result = await ImageProcessor.upscaleImageFast(file, (pct, stage) => {
      UI.updateProgress(pct, stage);
      DebugPanel.log('info', `[Fast Mode ${pct}%] ${stage}`);
    }, () => App.state.cancelled, App.settings.boostMode);

    if (App.state.cancelled) return finishCancelled();

    DebugPanel.log('success', `Fast Mode complete. Plan: ${JSON.stringify(result.plan)}${result.retried ? ' (retried once)' : ''}`);
    completeImageResult(file, result);

    if (result.retried) {
      Utils.showNotification('info', 'Auto-Retry Hui', 'Pehla result quality check me fail hua, gentler settings se dobara enhance kiya gaya.');
    }
  } catch (err) {
    DebugPanel.log('error', `Fast Mode failed: ${err.message}\n${err.stack || ''}`);
    handleProcessingError(err);
  }
}

async function startEnhancement() {
  if (App.state.isProcessing) return;

  if (!ONNXEngine.isLoaded) {
    Utils.showNotification('error', 'Model Load Nahi Hua', 'Pehle "Setup AI Model" section me model download & upload karo.');
    App.els.useLiteModelBtn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

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

async function runSingleImagePipeline(file) {
  beginProcessing('Enhancing Image', 'Preparing...');
  DebugPanel.log('info', `Starting single image pipeline for: ${file.name}`);

  try {
    await ensureModelLoaded();

    if (App.state.cancelled) return finishCancelled();

    UI.updateProgress(30, 'Preprocessing image...');
    DebugPanel.log('info', 'Model ready. Starting image upscale...');

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

async function runBatchImagePipeline() {
  beginProcessing('Processing Batch', 'Preparing...');
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
  // The model is now loaded exclusively via the "Setup AI Model" section
  // (download link + local upload), not fetched automatically here.
  if (ONNXEngine.isLoaded) {
    UI.updateProgress(25, 'AI model ready, reusing existing session...');
    DebugPanel.log('info', 'Model already loaded — reusing existing session.');
    return;
  }

  throw new Error(
    'AI model not loaded yet. Wait a few seconds for the Lite Model to finish loading in the background, or tap "Use Lite Model" in the AI Model section.'
  );
}

function beginProcessing(title, initialStage) {
  App.state.isProcessing = true;
  App.state.cancelled = false;
  App.state.startTime = Date.now();
  App.els.enhanceBtn.disabled = true;
  updateFastModeButtonState();

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
  updateFastModeButtonState();
  App.els.progressSection.classList.add('hidden');
  DebugPanel.log('info', 'Processing cancelled successfully.');
  Utils.showNotification('info', 'Cancelled', 'Processing was cancelled by user.');
}

function handleProcessingError(err) {
  console.error('Processing error:', err);
  App.state.isProcessing = false;
  App.els.enhanceBtn.disabled = false;
  updateFastModeButtonState();
  App.els.progressSection.classList.add('hidden');
  Utils.showNotification('error', 'Processing Failed', err.message || 'An unexpected error occurred during AI processing.');
}

function completeImageResult(originalFile, result, isBatch = false) {
  App.state.isProcessing = false;
  updateFastModeButtonState();
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
   COMPARE SECTION CONTROLS
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
