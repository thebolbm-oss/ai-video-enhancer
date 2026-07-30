
/* ==========================================================================
   AI VIDEO ENHANCER — IMAGE PROCESSOR MODULE (js/image.js)
   Handles the full Real-ESRGAN image upscaling pipeline:
   - Load image into canvas
   - Split into tiles (memory-safe processing for large images)
   - Convert each tile to a normalized RGB CHW tensor
   - Run ONNX inference on each tile
   - Convert output tensor back to image data
   - Stitch tiles back together into the final upscaled image
   - Optional denoise pass (simple bilateral-style smoothing on canvas)

   Two entry points:
   - upscaleImage()      — manual mode, uses the settings the person chose
                            in the Settings panel exactly as given.
   - upscaleImageFast()  — "Fast Mode": analyzes the image first (via
                            ImageAnalyzer), decides scale + pass strengths
                            automatically (via EnhancementPlanner), runs
                            the same AI model, and validates the result —
                            retrying once with milder settings if the
                            output actually came out worse than the input.

   LITE MODEL SUPPORT: the bundled lite model (RealESR-general-x4v3) only
   accepts fixed 128x128 input tiles. Every tile — including partial tiles
   at the image edges — is padded up to exactly 128x128 before inference,
   then the output is cropped back down to the tile's real (unpadded) area
   before stitching.
   ========================================================================== */

'use strict';

const ImageProcessor = {

  /* ------------------------------------------------------------------
     MAIN ENTRY POINT (MANUAL MODE) — Upscale a single image File
     settings: { scale, tileSize, faceEnhance, denoise, sharpen, edgeEnhance, textureEnhance }
     onProgress(percent 0-100, stageText)
     isCancelled(): function returning true if user cancelled
     Returns: { blob, width, height }
     ------------------------------------------------------------------ */
  async upscaleImage(file, settings, onProgress = () => {}, isCancelled = () => false) {
    onProgress(0, 'Reading image file...');

    const srcCanvas = await this._loadFileToCanvas(file);
    const scale = settings.scale || 4;

    // Pre-scale the source when a lower scale is requested — the model
    // always outputs a fixed 4x per tile, so shrinking the input first
    // (instead of upscaling fully then shrinking the output) means fewer/
    // smaller tiles and genuinely less AI compute time, not just a
    // smaller final file.
    let aiInput = srcCanvas;
    if (scale < 4) {
      const preScale = scale / 4;
      aiInput = this._resizeCanvas(
        srcCanvas,
        Math.max(1, Math.round(srcCanvas.width * preScale)),
        Math.max(1, Math.round(srcCanvas.height * preScale))
      );
    }

    const outCanvas = await this._runAIUpscale(aiInput, 4, (pct, stage) => {
      onProgress(Math.round(pct * 0.9), stage);
    }, isCancelled);
    const outCtx = outCanvas.getContext('2d');

    onProgress(92, 'Applying post-processing...');

    if (settings.denoise) {
      this._applyDenoise(outCtx, outCanvas.width, outCanvas.height);
    }

    if (settings.faceEnhance) {
      onProgress(94, 'Enhancing facial details...');
      this._safeGpuFilter(outCtx, outCanvas, 'sharpen', 0.5);
    }

    if (settings.sharpen) {
      onProgress(95, 'Sharpening (GPU)...');
      this._safeGpuFilter(outCtx, outCanvas, 'sharpen', 0.6);
    }

    if (settings.edgeEnhance) {
      onProgress(96, 'Enhancing edges (GPU)...');
      this._safeGpuFilter(outCtx, outCanvas, 'edge', 0.45);
    }

    if (settings.textureEnhance) {
      onProgress(97, 'Boosting texture/clarity...');
      try {
        PostProcess.applyTextureBoost(outCtx, outCanvas.width, outCanvas.height, 0.35);
      } catch (e) {
        DebugPanel.log('warn', `Texture boost skipped: ${e.message}`);
      }
    }

    onProgress(98, 'Encoding final image...');
    const blob = await Utils.canvasToBlob(outCanvas, 'image/png');

    onProgress(100, 'Done!');

    return {
      blob,
      width: outCanvas.width,
      height: outCanvas.height
    };
  },

  /* ------------------------------------------------------------------
     FAST MODE ENTRY POINT — Analyze first, decide the plan, enhance,
     then validate the result and retry once (milder) if it degraded.
     Always runs the AI model at its native 4x, then resizes down to
     the decided target scale if the plan calls for less than 4x —
     the lite model itself can't natively output 1.5x/2x/3x, so this
     is how "adaptive scaling" is actually achieved.
     Returns: { blob, width, height, inputMetrics, outputMetrics, plan, retried }
     ------------------------------------------------------------------ */
  async upscaleImageFast(file, onProgress = () => {}, isCancelled = () => false) {
    onProgress(0, 'Reading image file...');
    const srcCanvas = await this._loadFileToCanvas(file);

    onProgress(3, 'Analyzing image quality (resolution, blur, noise, contrast)...');
    const inputMetrics = ImageAnalyzer.analyze(srcCanvas);
    DebugPanel.log('info', `Fast Mode analysis: ${JSON.stringify(inputMetrics)}`);

    let plan = EnhancementPlanner.decide(inputMetrics);
    DebugPanel.log('info', `Fast Mode plan: ${JSON.stringify(plan)}`);
    onProgress(6, `Plan: ${plan.targetScale}x scale, adaptive denoise/sharpen/texture...`);

    let result = await this._runFastPipeline(srcCanvas, plan, onProgress, isCancelled);
    const outputMetrics = ImageAnalyzer.analyze(result.canvas);
    const validation = EnhancementPlanner.validate(inputMetrics, outputMetrics);
    let retried = false;

    if (!validation.passed) {
      DebugPanel.log('warn', `Fast Mode validation failed: ${validation.reason} Retrying with milder settings...`);
      onProgress(60, 'Quality check failed — retrying with gentler settings...');

      plan = {
        ...plan,
        denoiseAmount: plan.denoiseAmount * 0.5,
        sharpenAmount: Math.min(0.8, plan.sharpenAmount * 1.3), // less denoise blur, a bit more sharpen to compensate
        textureAmount: plan.textureAmount * 0.5
      };
      result = await this._runFastPipeline(srcCanvas, plan, onProgress, isCancelled);
      retried = true;
    } else {
      DebugPanel.log('success', 'Fast Mode validation passed on first attempt.');
    }

    onProgress(98, 'Encoding final image...');
    const blob = await Utils.canvasToBlob(result.canvas, 'image/png');
    onProgress(100, 'Done!');

    return {
      blob,
      width: result.canvas.width,
      height: result.canvas.height,
      inputMetrics,
      outputMetrics: ImageAnalyzer.analyze(result.canvas),
      plan,
      retried
    };
  },

  /* ------------------------------------------------------------------
     Runs one full pass of: AI upscale (4x) -> resize to target scale ->
     denoise -> sharpen -> texture -> color/contrast recovery, using the
     strengths given in `plan`. Shared by the first attempt and the retry.
     ------------------------------------------------------------------ */
  async _runFastPipeline(srcCanvas, plan, onProgress, isCancelled) {
    let outCanvas;

    if (plan.targetScale <= 1) {
      // Source is already large/sharp enough — AI upscaling would add
      // nothing real. Skip it entirely instead of running (and paying
      // the time cost of) a 4x pass just to shrink it back down.
      onProgress(30, 'Source already sharp enough — skipping AI upscale, applying cleanup only...');
      outCanvas = srcCanvas;
    } else if (plan.targetScale < 4) {
      // KEY SPEED OPTIMIZATION: instead of running the AI at its native 4x
      // on the full-size source and then shrinking the result down to the
      // target scale (which wastes real compute time — the AI still does
      // 4x worth of work no matter what you do to the output afterward),
      // we shrink the SOURCE first so that the AI's fixed 4x lands exactly
      // on the target scale. Fewer/smaller tiles = genuinely less work for
      // the AI, not just a smaller file at the end.
      const preScale = plan.targetScale / 4;
      onProgress(8, `Pre-scaling source by ${preScale.toFixed(2)}x so AI's native 4x lands on ${plan.targetScale}x target (this is what actually saves time)...`);
      const preScaledSrc = this._resizeCanvas(
        srcCanvas,
        Math.max(1, Math.round(srcCanvas.width * preScale)),
        Math.max(1, Math.round(srcCanvas.height * preScale))
      );
      outCanvas = await this._runAIUpscale(preScaledSrc, 4, (pct, stage) => {
        onProgress(10 + Math.round(pct * 0.5), stage); // 10-60%
      }, isCancelled);
    } else {
      // Full 4x requested — run AI at native resolution, no pre-scaling needed.
      outCanvas = await this._runAIUpscale(srcCanvas, 4, (pct, stage) => {
        onProgress(10 + Math.round(pct * 0.5), stage); // 10-60%
      }, isCancelled);
    }

    const outCtx = outCanvas.getContext('2d');

    if (plan.denoiseAmount > 0) {
      onProgress(70, 'Denoise pass...');
      this._applyDenoise(outCtx, outCanvas.width, outCanvas.height, plan.denoiseAmount);
    }

    if (plan.sharpenAmount > 0) {
      onProgress(80, 'Adaptive sharpen...');
      this._safeGpuFilter(outCtx, outCanvas, 'sharpen', plan.sharpenAmount);
    }

    if (plan.textureAmount > 0) {
      onProgress(88, 'Texture recovery...');
      try {
        PostProcess.applyTextureBoost(outCtx, outCanvas.width, outCanvas.height, plan.textureAmount);
      } catch (e) {
        DebugPanel.log('warn', `Texture recovery skipped: ${e.message}`);
      }
    }

    if (plan.colorBoost > 0 || plan.contrastBoost > 0) {
      onProgress(92, 'Color & contrast recovery...');
      this._applyColorContrastRecovery(outCtx, outCanvas.width, outCanvas.height, plan.colorBoost, plan.contrastBoost);
    }

    return { canvas: outCanvas };
  },

  /* ------------------------------------------------------------------
     LOAD A FILE INTO A FRESH SOURCE CANVAS
     ------------------------------------------------------------------ */
  async _loadFileToCanvas(file) {
    const { img, url } = await Utils.loadImageFromFile(file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return canvas;
  },

  /* ------------------------------------------------------------------
     RESIZE A CANVAS TO EXACT TARGET DIMENSIONS using progressive
     halving (repeatedly downscaling by ~2x) instead of one big jump —
     this avoids moire/aliasing artifacts that a single large downscale
     can introduce, giving a cleaner result.
     ------------------------------------------------------------------ */
  _resizeCanvas(sourceCanvas, targetWidth, targetHeight) {
    let current = sourceCanvas;
    let curW = current.width;
    let curH = current.height;

    while (curW > targetWidth * 1.5 || curH > targetHeight * 1.5) {
      const nextW = Math.max(targetWidth, Math.round(curW / 2));
      const nextH = Math.max(targetHeight, Math.round(curH / 2));
      const stepCanvas = document.createElement('canvas');
      stepCanvas.width = nextW;
      stepCanvas.height = nextH;
      const stepCtx = stepCanvas.getContext('2d');
      stepCtx.imageSmoothingEnabled = true;
      stepCtx.imageSmoothingQuality = 'high';
      stepCtx.drawImage(current, 0, 0, nextW, nextH);
      current = stepCanvas;
      curW = nextW;
      curH = nextH;
    }

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetWidth;
    finalCanvas.height = targetHeight;
    const finalCtx = finalCanvas.getContext('2d');
    finalCtx.imageSmoothingEnabled = true;
    finalCtx.imageSmoothingQuality = 'high';
    finalCtx.drawImage(current, 0, 0, targetWidth, targetHeight);

    return finalCanvas;
  },

  /* ------------------------------------------------------------------
     COLOR & CONTRAST RECOVERY — small native saturation/contrast boost.
     Amounts are small (plan.colorBoost/contrastBoost are typically
     0.04-0.15) so this stays natural instead of looking "processed."
     ------------------------------------------------------------------ */
  _applyColorContrastRecovery(ctx, width, height, colorBoost, contrastBoost) {
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d').drawImage(ctx.canvas, 0, 0);

    ctx.save();
    ctx.filter = `saturate(${1 + colorBoost}) contrast(${1 + contrastBoost})`;
    ctx.drawImage(original, 0, 0);
    ctx.restore();
  },

  /* ------------------------------------------------------------------
     RUN A GPU CONVOLUTION FILTER WITH A SAFE CPU FALLBACK
     ------------------------------------------------------------------ */
  _safeGpuFilter(ctx, canvas, kernelName, amount) {
    try {
      const result = PostProcess.applyConvolution(canvas, kernelName, amount);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(result, 0, 0);
    } catch (e) {
      if (kernelName === 'sharpen') {
        this._applySharpen(ctx, canvas.width, canvas.height);
      } else {
        DebugPanel.log('warn', `GPU filter "${kernelName}" skipped: ${e.message}`);
      }
    }
  },

  /* ------------------------------------------------------------------
     CORE AI UPSCALE — tiles the source canvas, runs it through the
     active ONNX model (lite model only, since the full model has been
     removed), and stitches the result back together with feathered
     seams. Returns a fresh canvas at srcCanvas size * scale.
     Shared by both upscaleImage() and upscaleImageFast().
     ------------------------------------------------------------------ */
  async _runAIUpscale(srcCanvas, scale, onProgress = () => {}, isCancelled = () => false) {
    const srcWidth = srcCanvas.width;
    const srcHeight = srcCanvas.height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });

    onProgress(5, 'Preparing tiles...');

    // The lite model only accepts fixed-size 128x128 tiles. To still get
    // seamless stitching, we shrink the "core" tile size so that core +
    // overlap-on-both-sides adds up to exactly 128 (its fixed input size).
    const LITE_OVERLAP = 16;
    const tileSize = ONNXEngine.LITE_MODEL_FIXED_TILE - 2 * LITE_OVERLAP; // 128 - 32 = 96
    const overlap = LITE_OVERLAP;

    const tiles = this._buildTileGrid(srcWidth, srcHeight, tileSize, overlap);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = srcWidth * scale;
    outCanvas.height = srcHeight * scale;
    const outCtx = outCanvas.getContext('2d');

    let processedTiles = 0;
    const totalTiles = tiles.length;

    for (const tile of tiles) {
      if (isCancelled()) {
        throw new Error('Processing cancelled by user.');
      }

      const stagePct = Math.round((processedTiles / totalTiles) * 100);
      onProgress(stagePct, `AI upscaling tile ${processedTiles + 1}/${totalTiles}...`);

      const tileImageData = srcCtx.getImageData(tile.sx, tile.sy, tile.sw, tile.sh);

      const fixedSize = ONNXEngine.LITE_MODEL_FIXED_TILE;
      const paddedImageData = this._padImageDataTo(tileImageData, fixedSize, fixedSize);
      const tensorData = this._imageDataToTensor(paddedImageData);

      const { data: outputData, dims } = await ONNXEngine.runInference(tensorData, fixedSize, fixedSize);

      const paddedOutImageData = this._tensorToImageData(outputData, dims[3], dims[2]);

      // Crop off the fixed-128 fill-padding (not the overlap padding), then
      // resize from the model's native 4x to whatever scale was requested.
      let outTileImageData = this._cropImageData(paddedOutImageData, 0, 0, tile.sw * 4, tile.sh * 4);

      if (scale !== 4) {
        const tileCanvasNative = document.createElement('canvas');
        tileCanvasNative.width = tile.sw * 4;
        tileCanvasNative.height = tile.sh * 4;
        tileCanvasNative.getContext('2d').putImageData(outTileImageData, 0, 0);
        const resized = this._resizeCanvas(tileCanvasNative, Math.round(tile.sw * scale), Math.round(tile.sh * scale));
        outTileImageData = resized.getContext('2d').getImageData(0, 0, resized.width, resized.height);
      }

      outTileImageData = this._applyFeather(
        outTileImageData,
        tile.padLeft * scale,
        tile.padRight * scale,
        tile.padTop * scale,
        tile.padBottom * scale
      );

      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = outTileImageData.width;
      tileCanvas.height = outTileImageData.height;
      tileCanvas.getContext('2d').putImageData(outTileImageData, 0, 0);

      outCtx.drawImage(tileCanvas, Math.round(tile.sx * scale), Math.round(tile.sy * scale));

      processedTiles++;
      await Utils.sleep(0);
    }

    return outCanvas;
  },

  /* ------------------------------------------------------------------
     BUILD TILE GRID
     Splits an image into a grid of overlapping tiles so that each tile
     (plus its padding) can be safely run through the AI model without
     exceeding GPU/WASM memory limits.
     Returns array of tile descriptors with source + destination coords.

     NOTE: dx/dy are in SOURCE-image pixel space (unscaled); callers
     multiply by `scale` when drawing onto the output canvas.
     ------------------------------------------------------------------ */
  _buildTileGrid(srcWidth, srcHeight, tileSize, overlap) {
    const tiles = [];
    const coreSize = tileSize; // The "useful" area of each tile before padding

    for (let y = 0; y < srcHeight; y += coreSize) {
      for (let x = 0; x < srcWidth; x += coreSize) {
        const coreW = Math.min(coreSize, srcWidth - x);
        const coreH = Math.min(coreSize, srcHeight - y);

        // Padded region (may extend beyond core, clipped to image bounds)
        const padLeft = Math.min(overlap, x);
        const padTop = Math.min(overlap, y);
        const padRight = Math.min(overlap, srcWidth - (x + coreW));
        const padBottom = Math.min(overlap, srcHeight - (y + coreH));

        const sx = x - padLeft;
        const sy = y - padTop;
        const sw = coreW + padLeft + padRight;
        const sh = coreH + padTop + padBottom;

        tiles.push({
          sx, sy, sw, sh,
          padLeft, padTop, padRight, padBottom,
          coreW, coreH,
          dx: x, // destination x in SOURCE-image pixel space (scaled later by caller)
          dy: y
        });
      }
    }

    return tiles;
  },

  /* ------------------------------------------------------------------
     PAD IMAGEDATA UP TO A FIXED WIDTH/HEIGHT (bottom/right padding,
     replicating edge pixels so the model doesn't see a hard black edge)
     Used only for the lite model's fixed 128x128 input requirement.
     ------------------------------------------------------------------ */
  _padImageDataTo(imageData, targetWidth, targetHeight) {
    const { width, height } = imageData;
    if (width === targetWidth && height === targetHeight) {
      return imageData;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // Draw the source tile first
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    srcCanvas.getContext('2d').putImageData(imageData, 0, 0);
    ctx.drawImage(srcCanvas, 0, 0);

    // Replicate the last column to fill the right padding
    if (width < targetWidth) {
      ctx.drawImage(srcCanvas, width - 1, 0, 1, height, width, 0, targetWidth - width, height);
    }
    // Replicate the last row (now including the right padding we just drew) to fill bottom padding
    if (height < targetHeight) {
      const currentImg = ctx.getImageData(0, 0, targetWidth, height);
      const rowCanvas = document.createElement('canvas');
      rowCanvas.width = targetWidth;
      rowCanvas.height = 1;
      rowCanvas.getContext('2d').putImageData(
        ctx.getImageData(0, height - 1, targetWidth, 1), 0, 0
      );
      ctx.drawImage(rowCanvas, 0, height, targetWidth, targetHeight - height);
    }

    return ctx.getImageData(0, 0, targetWidth, targetHeight);
  },

  /* ------------------------------------------------------------------
     CROP IMAGEDATA DOWN TO A SMALLER REGION (top-left aligned)
     Used to strip the lite model's padding back off after inference.
     ------------------------------------------------------------------ */
  _cropImageData(imageData, x, y, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    return outCtx.getImageData(0, 0, w, h);
  },

  /* ------------------------------------------------------------------
     APPLY FEATHER (smooth alpha fade) ON TILE EDGES THAT HAVE OVERLAP
     WITH A NEIGHBOR. This is what actually removes visible tile seams:
     instead of hard-cropping each tile to its "core" area and pasting
     with a sharp edge, we keep the full overlap region and fade its
     alpha from 0 (at the outer edge) to 1 (at the inner/core edge).
     When two neighboring tiles are drawn one after another with
     complementary fades in their shared overlap band, normal alpha
     compositing blends them smoothly instead of showing a hard line.
     Edges that touch the actual image boundary (pad = 0, no neighbor)
     are left fully opaque — only shared internal edges get feathered.
     ------------------------------------------------------------------ */
  _applyFeather(imageData, padLeft, padRight, padTop, padBottom) {
    if (padLeft <= 0 && padRight <= 0 && padTop <= 0 && padBottom <= 0) {
      return imageData; // nothing to feather — no neighbors on any side
    }

    const { width, height, data } = imageData;

    for (let y = 0; y < height; y++) {
      let vFade = 1;
      if (padTop > 0 && y < padTop) vFade = Math.min(vFade, y / padTop);
      if (padBottom > 0 && y >= height - padBottom) vFade = Math.min(vFade, (height - 1 - y) / padBottom);

      for (let x = 0; x < width; x++) {
        let hFade = 1;
        if (padLeft > 0 && x < padLeft) hFade = Math.min(hFade, x / padLeft);
        if (padRight > 0 && x >= width - padRight) hFade = Math.min(hFade, (width - 1 - x) / padRight);

        const fade = hFade * vFade;
        if (fade < 1) {
          const alphaIdx = (y * width + x) * 4 + 3;
          data[alphaIdx] = Math.round(data[alphaIdx] * fade);
        }
      }
    }

    return imageData;
  },

  /* ------------------------------------------------------------------
     CONVERT IMAGEDATA -> NORMALIZED FLOAT32 CHW TENSOR
     ImageData is RGBA, HWC, 0-255. Model expects RGB, CHW, 0-1 float.
     ------------------------------------------------------------------ */
  _imageDataToTensor(imageData) {
    const { width, height, data } = imageData;
    const pixelCount = width * height;
    const tensor = new Float32Array(pixelCount * 3);

    // Plane-separated CHW layout: [R plane][G plane][B plane]
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * 4;
      tensor[i] = data[srcIdx] / 255;                       // R plane
      tensor[pixelCount + i] = data[srcIdx + 1] / 255;       // G plane
      tensor[pixelCount * 2 + i] = data[srcIdx + 2] / 255;   // B plane
    }

    return tensor;
  },

  /* ------------------------------------------------------------------
     CONVERT FLOAT32 CHW TENSOR -> IMAGEDATA (RGBA, HWC, 0-255)
     ------------------------------------------------------------------ */
  _tensorToImageData(tensorData, width, height) {
    const pixelCount = width * height;
    const imageData = new ImageData(width, height);

    for (let i = 0; i < pixelCount; i++) {
      const r = Utils.clamp(tensorData[i], 0, 1) * 255;
      const g = Utils.clamp(tensorData[pixelCount + i], 0, 1) * 255;
      const b = Utils.clamp(tensorData[pixelCount * 2 + i], 0, 1) * 255;

      const dstIdx = i * 4;
      imageData.data[dstIdx] = r;
      imageData.data[dstIdx + 1] = g;
      imageData.data[dstIdx + 2] = b;
      imageData.data[dstIdx + 3] = 255; // fully opaque
    }

    return imageData;
  },

  /* ------------------------------------------------------------------
     DENOISE PASS — light blur+blend to reduce AI artifacts
     Uses the browser's native, hardware-accelerated canvas blur filter
     instead of a manual per-pixel JS loop. A manual 3x3 loop over a
     large 4x-upscaled image (e.g. a video frame at 2880x5120 = ~15M
     pixels x 9 samples each) is extremely slow in interpreted JS —
     this is one of the biggest reasons video enhancement was slow.
     The native filter achieves the same "70% original + 30% blurred"
     smoothing look, just computed natively instead of pixel-by-pixel.
     ------------------------------------------------------------------ */
  _applyDenoise(ctx, width, height, amount = 0.3) {
    // Snapshot the current (sharp) output before blending a blurred copy over it
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d').drawImage(ctx.canvas, 0, 0);

    ctx.save();
    ctx.filter = 'blur(0.6px)';   // light touch, matches the old radius-1 softness
    ctx.globalAlpha = amount;      // default 0.3 matches the old fixed 70/30 blend ratio
    ctx.drawImage(original, 0, 0);
    ctx.restore();
  },

  /* ------------------------------------------------------------------
     SIMPLE SHARPEN PASS — used for "Face Enhancement" toggle
     Applies an unsharp-mask style 3x3 convolution kernel.
     ------------------------------------------------------------------ */
  _applySharpen(ctx, width, height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);

    // Standard sharpening kernel
    const kernel = [
      0, -0.25, 0,
      -0.25, 2, -0.25,
      0, -0.25, 0
    ];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let rSum = 0, gSum = 0, bSum = 0;
        let k = 0;

        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const nx = Utils.clamp(x + kx, 0, width - 1);
            const ny = Utils.clamp(y + ky, 0, height - 1);
            const idx = (ny * width + nx) * 4;
            const weight = kernel[k++];
            rSum += src[idx] * weight;
            gSum += src[idx + 1] * weight;
            bSum += src[idx + 2] * weight;
          }
        }

        const outIdx = (y * width + x) * 4;
        out[outIdx] = rSum;
        out[outIdx + 1] = gSum;
        out[outIdx + 2] = bSum;
        out[outIdx + 3] = src[outIdx + 3];
      }
    }

    imageData.data.set(out);
    ctx.putImageData(imageData, 0, 0);
  }
};
