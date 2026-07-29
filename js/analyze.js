
/* ==========================================================================
   AI VIDEO ENHANCER — IMAGE ANALYZER MODULE (js/analyze.js)
   Computes classical, formula-based (NOT machine-learning) quality
   metrics from an image: sharpness/blur, contrast, saturation,
   brightness, and a rough noise estimate.

   IMPORTANT HONESTY NOTE: this does not know what's IN the image — it
   cannot tell "this is a face" or "this is anime" the way a trained
   content-classification model could. It only measures statistical
   properties of the pixels (edge strength, tonal spread, color
   intensity). Fast Mode uses these numbers to make sensible automatic
   decisions, but this is a heuristic engine, not a perception model.

   All analysis runs on a downscaled copy (max 256px on the long side)
   for speed — these are aggregate statistics, so full resolution isn't
   needed to get a useful reading, and this keeps analysis near-instant
   even on large images.
   ========================================================================== */

'use strict';

const ImageAnalyzer = {

  /* ------------------------------------------------------------------
     ANALYZE A CANVAS AND RETURN QUALITY METRICS
     Returns: {
       width, height,          — original dimensions (not the sample size)
       sharpness,               — Laplacian variance; higher = sharper/more detail
       contrast,                 — luminance standard deviation
       saturation,               — average color saturation, 0-1
       brightness,               — average luminance, 0-255
       noiseEstimate             — rough proxy, 0-1 (not a scientific measure)
     }
     ------------------------------------------------------------------ */
  analyze(sourceCanvas) {
    const maxDim = 256;
    const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
    const w = Math.max(2, Math.round(sourceCanvas.width * scale));
    const h = Math.max(2, Math.round(sourceCanvas.height * scale));

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = w;
    sampleCanvas.height = h;
    const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(sourceCanvas, 0, 0, w, h);
    const imageData = sctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const gray = new Float32Array(w * h);
    let sumLum = 0;
    let sumSat = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[p] = lum;
      sumLum += lum;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      sumSat += max === 0 ? 0 : (max - min) / max;
    }

    const pixelCount = gray.length;
    const meanLum = sumLum / pixelCount;
    const meanSat = sumSat / pixelCount;

    // Sharpness/blur estimate via Laplacian variance — a well-known,
    // simple no-reference sharpness metric: sharp images have high local
    // second-derivative variance (strong edges everywhere), blurry
    // images have low variance (smooth transitions everywhere).
    let lapSum = 0;
    let lapSumSq = 0;
    let lapCount = 0;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const lap = (
          -4 * gray[idx] +
          gray[idx - 1] + gray[idx + 1] +
          gray[idx - w] + gray[idx + w]
        );
        lapSum += lap;
        lapSumSq += lap * lap;
        lapCount++;
      }
    }

    const lapMean = lapCount > 0 ? lapSum / lapCount : 0;
    const sharpness = lapCount > 0 ? (lapSumSq / lapCount) - (lapMean * lapMean) : 0;

    // Contrast via luminance standard deviation
    let varLum = 0;
    for (let p = 0; p < pixelCount; p++) {
      const diff = gray[p] - meanLum;
      varLum += diff * diff;
    }
    const contrast = Math.sqrt(varLum / pixelCount);

    // Rough noise proxy — NOT a scientific noise measurement, just a
    // bounded signal derived from sharpness variance that Fast Mode uses
    // to nudge denoise strength. A proper noise estimator would need
    // frequency-domain analysis, which is out of scope here.
    const noiseEstimate = Math.min(1, sharpness / 4000);

    return {
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      sharpness,
      contrast,
      saturation: meanSat,
      brightness: meanLum,
      noiseEstimate
    };
  }
};
