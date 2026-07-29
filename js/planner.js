
/* ==========================================================================
   AI VIDEO ENHANCER — ENHANCEMENT PLANNER MODULE (js/planner.js)
   Rule-based (NOT machine-learned) decision engine for Fast Mode.
   Takes the metrics from ImageAnalyzer and decides:
     - What scale to target (1x-4x) — the AI model itself always runs
       at a fixed 4x; if the plan calls for less, image.js resizes the
       4x output back down. This is how "adaptive scaling" is achieved
       without a model that natively supports variable scale factors.
     - How strong each enhancement pass should be (denoise, sharpen,
       texture recovery, color/contrast recovery).

   HONESTY NOTE: these are hand-written heuristic rules based on
   measurable statistics (sharpness, contrast, resolution, noise proxy).
   This is not a trained model and doesn't understand image content —
   it can't tell faces from landscapes from text. It reacts only to the
   numbers ImageAnalyzer produces.
   ========================================================================== */

'use strict';

const EnhancementPlanner = {

  /* ------------------------------------------------------------------
     DECIDE THE ENHANCEMENT PLAN FROM INPUT METRICS
     Returns: { targetScale, denoiseAmount, sharpenAmount, textureAmount,
                colorBoost, contrastBoost }
     ------------------------------------------------------------------ */
  decide(metrics) {
    const { width, height, sharpness, contrast, saturation, noiseEstimate } = metrics;
    const longSide = Math.max(width, height);

    // ---- Adaptive scale: bigger/sharper sources need less (or no) upscale ----
    let targetScale;
    if (longSide >= 2000 && sharpness > 800) {
      targetScale = 1;    // already large & sharp — upscaling adds nothing real
    } else if (longSide >= 1400 && sharpness > 500) {
      targetScale = 1.5;
    } else if (longSide >= 800) {
      targetScale = 2;
    } else if (longSide >= 400) {
      targetScale = 3;
    } else {
      targetScale = 4;    // small/low-res source — full 4x is worth it
    }

    // ---- Denoise strength — more for noisier-looking sources ----
    const denoiseAmount = Math.min(0.6, 0.15 + noiseEstimate * 0.6);

    // ---- Adaptive sharpen — softer/blurrier sources get more, already-sharp less ----
    const sharpenAmount = sharpness > 600 ? 0.25 : sharpness > 250 ? 0.45 : 0.65;

    // ---- Texture recovery — helps soft images bring back surface detail ----
    const textureAmount = sharpness < 400 ? 0.35 : 0.2;

    // ---- Color / contrast recovery — boost more if source looks flat/washed out ----
    const colorBoost = saturation < 0.25 ? 0.15 : 0.05;
    const contrastBoost = contrast < 35 ? 0.12 : 0.04;

    return {
      targetScale,
      denoiseAmount,
      sharpenAmount,
      textureAmount,
      colorBoost,
      contrastBoost
    };
  },

  /* ------------------------------------------------------------------
     FINAL QUALITY VALIDATION
     Compares output metrics against input metrics. If the pipeline
     actually made the image noticeably SOFTER than the input (a sign
     that denoise ran too strong, or something else degraded detail),
     signal that a retry with gentler settings is warranted.
     This is a heuristic safety net, not a learned perceptual model —
     it only checks one thing (relative sharpness), not a full
     perceptual quality comparison.
     ------------------------------------------------------------------ */
  validate(inputMetrics, outputMetrics) {
    const gotSofter = outputMetrics.sharpness < inputMetrics.sharpness * 0.9;
    return {
      passed: !gotSofter,
      reason: gotSofter
        ? 'Output sharpness dropped below the input — denoise or resizing likely over-softened the result.'
        : 'OK'
    };
  }
};
