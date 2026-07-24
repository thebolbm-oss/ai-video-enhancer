
/* ==========================================================================
   AI VIDEO ENHANCER — UTILS MODULE (js/utils.js)
   Shared helper functions used across the entire application:
   - Notifications
   - File validation
   - Byte / time formatting
   - ID generation
   - Blob downloading
   - Image loading helpers
   - Debounce
   ========================================================================== */

'use strict';

const Utils = {

  /* ------------------------------------------------------------------
     NOTIFICATION SYSTEM
     type: 'success' | 'error' | 'warning' | 'info'
     ------------------------------------------------------------------ */
  showNotification(type, title, message, duration = 4500) {
    const container = document.getElementById('notificationContainer');
    if (!container) return;

    const icons = {
      success: 'fa-solid fa-circle-check',
      error: 'fa-solid fa-circle-exclamation',
      warning: 'fa-solid fa-triangle-exclamation',
      info: 'fa-solid fa-circle-info'
    };

    const note = document.createElement('div');
    note.className = `notification ${type}`;
    note.innerHTML = `
      <i class="notif-icon ${icons[type] || icons.info}"></i>
      <div class="notif-content">
        <h5>${Utils.escapeHTML(title)}</h5>
        <p>${Utils.escapeHTML(message)}</p>
      </div>
      <i class="notif-close fa-solid fa-xmark"></i>
    `;

    container.appendChild(note);

    const removeNote = () => {
      note.classList.add('removing');
      setTimeout(() => note.remove(), 350);
    };

    note.querySelector('.notif-close').addEventListener('click', removeNote);
    setTimeout(removeNote, duration);
  },

  /* ------------------------------------------------------------------
     ESCAPE HTML — prevent injection via file names / dynamic text
     ------------------------------------------------------------------ */
  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /* ------------------------------------------------------------------
     FILE VALIDATION
     type: 'image' | 'video'
     ------------------------------------------------------------------ */
  validateFile(file, type, maxSizeMB) {
    if (!file) {
      return { valid: false, message: 'No file provided.' };
    }

    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp'];
    const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/mpeg'];

    const allowedTypes = type === 'image' ? imageTypes : videoTypes;

    if (!allowedTypes.includes(file.type)) {
      return {
        valid: false,
        message: `"${file.name}" is not a supported ${type} format.`
      };
    }

    const maxBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxBytes) {
      return {
        valid: false,
        message: `"${file.name}" exceeds the ${maxSizeMB}MB size limit.`
      };
    }

    return { valid: true, message: 'OK' };
  },

  /* ------------------------------------------------------------------
     FORMAT BYTES -> Human readable string
     ------------------------------------------------------------------ */
  formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  },

  /* ------------------------------------------------------------------
     FORMAT SECONDS -> mm:ss or hh:mm:ss
     ------------------------------------------------------------------ */
  formatTime(totalSeconds) {
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  },

  /* ------------------------------------------------------------------
     UNIQUE ID GENERATOR (for batch queue items etc.)
     ------------------------------------------------------------------ */
  generateId() {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  },

  /* ------------------------------------------------------------------
     DOWNLOAD A BLOB AS A FILE
     ------------------------------------------------------------------ */
  downloadBlob(blob, filename) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give the browser a tick to start the download before revoking
      setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve();
      }, 300);
    });
  },

  /* ------------------------------------------------------------------
     LOAD A FILE (image) INTO AN HTMLImageElement, RETURNS PROMISE
     ------------------------------------------------------------------ */
  loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image file. It may be corrupted.'));
      };
      img.src = url;
    });
  },

  /* ------------------------------------------------------------------
     CONVERT A CANVAS TO A BLOB (Promise wrapper)
     ------------------------------------------------------------------ */
  canvasToBlob(canvas, mimeType = 'image/png', quality = 0.92) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas to Blob conversion failed.'));
      }, mimeType, quality);
    });
  },

  /* ------------------------------------------------------------------
     DEBOUNCE — limit how often a function can fire
     ------------------------------------------------------------------ */
  debounce(fn, delay = 200) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  /* ------------------------------------------------------------------
     CLAMP A NUMBER BETWEEN MIN AND MAX
     ------------------------------------------------------------------ */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  /* ------------------------------------------------------------------
     SLEEP — await a delay (used to yield UI thread between heavy tasks)
     ------------------------------------------------------------------ */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /* ------------------------------------------------------------------
     GET IMAGE DIMENSIONS FROM A FILE WITHOUT FULLY DECODING CANVAS
     ------------------------------------------------------------------ */
  async getImageDimensions(file) {
    const { img, url } = await Utils.loadImageFromFile(file);
    const dims = { width: img.naturalWidth, height: img.naturalHeight };
    URL.revokeObjectURL(url);
    return dims;
  },

  /* ------------------------------------------------------------------
     SAFE JSON PARSE
     ------------------------------------------------------------------ */
  safeJSONParse(str, fallback = null) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback;
    }
  }
};