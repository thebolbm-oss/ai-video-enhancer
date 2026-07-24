
/* ==========================================================================
   AI VIDEO ENHANCER — UI MODULE (js/ui.js)
   Handles all DOM rendering and interactive UI behavior:
   - Dark/Light theme toggle (persisted in memory for session)
   - Navbar scroll shrink effect
   - Mobile drawer menu
   - Scroll-spy active nav link highlighting
   - Info modal open/close
   - Upload card file preview rendering
   - Batch queue list rendering
   - Progress bar updates
   - Before/After compare slider (drag + touch support)
   - Download section rendering
   ========================================================================== */

'use strict';

const UI = {

  /* ------------------------------------------------------------------
     THEME TOGGLE (Dark <-> Light)
     ------------------------------------------------------------------ */
  initTheme() {
    const themeBtn = document.getElementById('themeToggleBtn');
    if (!themeBtn) return;

    const icon = themeBtn.querySelector('i');

    themeBtn.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-theme');
      icon.className = isLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      Utils.showNotification('info', 'Theme Changed', isLight ? 'Light mode enabled.' : 'Dark mode enabled.');
    });
  },

  /* ------------------------------------------------------------------
     NAVBAR — Shrink / add shadow effect on scroll
     ------------------------------------------------------------------ */
  initNavbarScroll() {
    const navbar = document.getElementById('navbar');
    if (!navbar) return;

    let lastScroll = 0;
    window.addEventListener('scroll', () => {
      const current = window.scrollY;
      if (current > 40) {
        navbar.style.boxShadow = '0 8px 30px rgba(0,0,0,0.35)';
        navbar.style.padding = '10px 0';
      } else {
        navbar.style.boxShadow = '';
        navbar.style.padding = '14px 0';
      }
      lastScroll = current;
    }, { passive: true });
  },

  /* ------------------------------------------------------------------
     MOBILE DRAWER — Open / close hamburger menu
     ------------------------------------------------------------------ */
  initMobileDrawer() {
    const menuBtn = document.getElementById('menuToggleBtn');
    const closeBtn = document.getElementById('closeDrawerBtn');
    const drawer = document.getElementById('mobileDrawer');
    const backdrop = document.getElementById('drawerBackdrop');

    if (!menuBtn || !drawer || !backdrop) return;

    const openDrawer = () => {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      document.body.style.overflow = 'hidden';
    };

    const closeDrawer = () => {
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      document.body.style.overflow = '';
    };

    menuBtn.addEventListener('click', openDrawer);
    closeBtn.addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', closeDrawer);

    // Close drawer automatically when a nav link is tapped
    drawer.querySelectorAll('.drawer-link').forEach(link => {
      link.addEventListener('click', closeDrawer);
    });
  },

  /* ------------------------------------------------------------------
     SCROLL SPY — Highlight active nav link based on section in view
     ------------------------------------------------------------------ */
  initScrollSpy() {
    const sections = document.querySelectorAll('main section[id], footer[id]');
    const navLinks = document.querySelectorAll('.nav-link');

    if (sections.length === 0 || navLinks.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          });
        }
      });
    }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 });

    sections.forEach(section => observer.observe(section));
  },

  /* ------------------------------------------------------------------
     INFO MODAL — Open / close about modal
     (Hooked to any element with [data-open-info-modal] if added later;
     also exposes manual open/close for programmatic use.)
     ------------------------------------------------------------------ */
  initModal() {
    const backdrop = document.getElementById('infoModalBackdrop');
    const closeBtn = document.getElementById('closeInfoModalBtn');
    if (!backdrop || !closeBtn) return;

    const close = () => backdrop.classList.add('hidden');
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    // Expose globally so other modules/buttons can trigger it
    UI.openInfoModal = () => backdrop.classList.remove('hidden');
    UI.closeInfoModal = close;
  },

  /* ------------------------------------------------------------------
     RENDER FILE PREVIEW — Shows selected file inside the upload card
     ------------------------------------------------------------------ */
  renderFilePreview(file, objectURL, onRemove) {
    const uploadCard = document.getElementById('uploadCard');
    const dropZone = document.getElementById('dropZone');
    if (!uploadCard || !dropZone) return;

    uploadCard.classList.add('file-loaded');

    const isImage = file.type.startsWith('image/');
    const thumbHTML = isImage
      ? `<img src="${objectURL}" class="file-preview-thumb" alt="Preview" />`
      : `<video src="${objectURL}" class="file-preview-thumb" muted></video>`;

    dropZone.innerHTML = `
      <div class="file-preview-box">
        ${thumbHTML}
        <div class="file-preview-info">
          <h4>${Utils.escapeHTML(file.name)}</h4>
          <p>${Utils.formatBytes(file.size)} &bull; ${Utils.escapeHTML(file.type || 'Unknown type')}</p>
        </div>
        <button class="file-remove-btn" id="filePreviewRemoveBtn" title="Remove file">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;

    document.getElementById('filePreviewRemoveBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
  },

  /* ------------------------------------------------------------------
     RESET UPLOAD CARD BACK TO DEFAULT EMPTY DROPZONE STATE
     ------------------------------------------------------------------ */
  resetUploadCard() {
    const uploadCard = document.getElementById('uploadCard');
    const dropZone = document.getElementById('dropZone');
    if (!uploadCard || !dropZone) return;

    uploadCard.classList.remove('file-loaded');

    dropZone.innerHTML = `
      <div class="upload-icon-wrap">
        <i class="fa-solid fa-cloud-arrow-up upload-icon"></i>
      </div>
      <h3>Drag &amp; Drop your file here</h3>
      <p>or click the button below to browse</p>
      <button class="btn btn-primary" id="browseBtn">
        <i class="fa-solid fa-folder-open"></i> Browse File
      </button>
      <span class="upload-hint" id="uploadHint">Supported: JPG, PNG, WEBP (Max 25MB)</span>
    `;

    // Re-cache and re-bind the browse button since we just replaced it in the DOM
    const fileInput = document.getElementById('fileInput');
    const newBrowseBtn = document.getElementById('browseBtn');
    if (newBrowseBtn && fileInput) {
      newBrowseBtn.addEventListener('click', () => fileInput.click());
      App.els.browseBtn = newBrowseBtn;
    }
    App.els.uploadHint = document.getElementById('uploadHint');
  },

  /* ------------------------------------------------------------------
     RENDER BATCH QUEUE LIST
     items: array of { id, file, status } where status is 'queued'|'processing'|'done'
     onRemove(id): callback fired when the remove (x) icon is clicked
     ------------------------------------------------------------------ */
  renderBatchList(items, onRemove) {
    const listEl = document.getElementById('batchItems');
    if (!listEl) return;

    if (items.length === 0) {
      listEl.innerHTML = '';
      return;
    }

    listEl.innerHTML = items.map(item => {
      const statusLabel = item.status === 'done'
        ? 'Done'
        : item.status === 'processing'
          ? 'Processing...'
          : 'Queued';
      const statusClass = item.status === 'done' ? 'done' : '';
      const removable = item.status === 'queued';

      return `
        <li class="batch-item" data-id="${item.id}">
          <i class="fa-solid fa-image"></i>
          <span>${Utils.escapeHTML(item.file.name)}</span>
          <span class="batch-status ${statusClass}">${statusLabel}</span>
          ${removable ? `<i class="fa-solid fa-xmark batch-remove" title="Remove"></i>` : ''}
        </li>
      `;
    }).join('');

    // Wire up remove buttons
    listEl.querySelectorAll('.batch-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const li = e.target.closest('.batch-item');
        const id = li.getAttribute('data-id');
        onRemove(id);
      });
    });
  },

  /* ------------------------------------------------------------------
     UPDATE PROGRESS BAR + PERCENTAGE + STAGE TEXT + ETA
     ------------------------------------------------------------------ */
  _progressStartTime: null,

  updateProgress(percent, stageText) {
    const bar = document.getElementById('progressBarInner');
    const pctText = document.getElementById('progressPercent');
    const stage = document.getElementById('progressStage');
    const eta = document.getElementById('progressEta');

    if (!bar || !pctText || !stage) return;

    const clamped = Utils.clamp(percent, 0, 100);

    if (clamped <= 1 || UI._progressStartTime === null) {
      UI._progressStartTime = Date.now();
    }

    bar.style.width = `${clamped}%`;
    pctText.textContent = `${clamped}%`;
    stage.textContent = stageText || 'Processing...';

    if (eta) {
      if (clamped > 3 && clamped < 100) {
        const elapsed = (Date.now() - UI._progressStartTime) / 1000;
        const estimatedTotal = elapsed / (clamped / 100);
        const remaining = Math.max(0, estimatedTotal - elapsed);
        eta.textContent = `ETA: ${Utils.formatTime(remaining)}`;
      } else if (clamped >= 100) {
        eta.textContent = 'Complete!';
      } else {
        eta.textContent = 'Estimating time...';
      }
    }
  },

  /* ------------------------------------------------------------------
     SET COMPARE SLIDER IMAGES (Before / After)
     ------------------------------------------------------------------ */
  setCompareImages(originalURL, enhancedURL) {
    const originalImg = document.getElementById('originalImage');
    const enhancedImg = document.getElementById('enhancedImage');
    const compareAfter = document.getElementById('compareAfter');
    const sliderLine = document.getElementById('compareSliderLine');

    if (!originalImg || !enhancedImg) return;

    originalImg.src = originalURL;
    enhancedImg.src = enhancedURL;

    // Ensure the "after" image visually matches the container width so the
    // clipped half lines up perfectly with the "before" image underneath.
    const syncWidth = () => {
      const containerWidth = originalImg.clientWidth || originalImg.parentElement.clientWidth;
      enhancedImg.style.width = `${containerWidth}px`;
      enhancedImg.style.maxWidth = 'none';
    };

    if (originalImg.complete) {
      syncWidth();
    } else {
      originalImg.onload = syncWidth;
    }
    window.addEventListener('resize', Utils.debounce(syncWidth, 150));

    // Reset slider to center position
    compareAfter.style.width = '50%';
    sliderLine.style.left = '50%';
  },

  /* ------------------------------------------------------------------
     INIT COMPARE SLIDER — Drag/touch handling for before/after divider
     ------------------------------------------------------------------ */
  initCompareSlider() {
    const container = document.getElementById('compareContainer');
    const sliderLine = document.getElementById('compareSliderLine');
    const compareAfter = document.getElementById('compareAfter');

    if (!container || !sliderLine || !compareAfter) return;

    let isDragging = false;

    const moveSlider = (clientX) => {
      const rect = container.getBoundingClientRect();
      let pos = ((clientX - rect.left) / rect.width) * 100;
      pos = Utils.clamp(pos, 0, 100);
      compareAfter.style.width = `${pos}%`;
      sliderLine.style.left = `${pos}%`;
    };

    const startDrag = (e) => {
      isDragging = true;
      container.style.cursor = 'ew-resize';
    };

    const endDrag = () => {
      isDragging = false;
      container.style.cursor = '';
    };

    const onDrag = (e) => {
      if (!isDragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      moveSlider(clientX);
    };

    // Mouse events
    sliderLine.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);

    // Touch events (mobile)
    sliderLine.addEventListener('touchstart', startDrag, { passive: true });
    window.addEventListener('touchmove', onDrag, { passive: true });
    window.addEventListener('touchend', endDrag);

    // Also allow clicking anywhere on the image to jump the slider there
    container.addEventListener('click', (e) => {
      if (e.target === sliderLine || sliderLine.contains(e.target)) return;
      moveSlider(e.clientX);
    });
  },

  /* ------------------------------------------------------------------
     SHOW DOWNLOAD SECTION with result stats filled in
     data: { originalSize, enhancedSize, resolution, timeTaken, info }
     ------------------------------------------------------------------ */
  showDownloadSection(data) {
    const section = document.getElementById('downloadSection');
    if (!section) return;

    document.getElementById('downloadInfo').textContent = data.info || 'Your file has been enhanced successfully.';
    document.getElementById('originalSizeText').textContent = data.originalSize || '--';
    document.getElementById('enhancedSizeText').textContent = data.enhancedSize || '--';
    document.getElementById('resolutionText').textContent = data.resolution || '--';
    document.getElementById('timeTakenText').textContent = data.timeTaken || '--';

    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};