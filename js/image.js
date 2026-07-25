
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

   LITE MODEL SUPPORT: the bundled lite model (RealESR-general-x4v3) only
   accepts fixed 128x128 input tiles. When it's the active model, every
   tile — including partial tiles at the image edges — is padded up to
   exactly 128x128 before inference, then the output is cropped back down
   to the tile's real (unpadded) area before stitching. The full
   Real-ESRGAN model keeps working exactly as before (dynamic tile sizes).
   ========================================================================== */

'use strict';

const ImageProcessor = {

  /* ------------------------------------------------------------------
     MAIN ENTRY POINT — Upscale a single image File using Real-ESRGAN
     settings: { scale, tileSize, faceEnhance, denoise, backend }
     onProgress(percent 0-100, stageText)
     isCancelled(): function returning true if user cancelled
     Returns: { blob, width, height }
     ------------------------------------------------------------------ */
  async upscaleImage(file, settings, onProgress = () => {}, isCancelled = () => false) {
    onProgress(0, 'Reading image file...');

    const { img, url } = await Utils.loadImageFromFile(file);
    const srcWidth = img.naturalWidth;
    const srcHeight = img.naturalHeight;

    // Draw the source image onto a canvas so we can read pixel data
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcWidth;
    srcCanvas.height = srcHeight;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    onProgress(5, 'Preparing tiles...');

    const scale = settings.scale || 4;
    const isLiteModel = ONNXEngine.activeModelType === 'lite';

    // The lite model only accepts fixed-size 128x128 tiles — force that tile
    // size regardless of what the user picked in Settings when it's active.
    const tileSize = isLiteModel
      ? ONNXEngine.LITE_MODEL_FIXED_TILE
      : (settings.tileSize && settings.tileSize > 0 ? settings.tileSize : Math.max(srcWidth, srcHeight));

    const overlap = isLiteModel ? 0 : 16; // Padding around each tile to avoid seam artifacts (full model only)

    // Build a list of tile regions covering the full image
    const tiles = this._buildTileGrid(srcWidth, srcHeight, tileSize, overlap);

    // Output canvas is scale x bigger than source
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

      const stagePct = Math.round((processedTiles / totalTiles) * 90);
      onProgress(stagePct, `AI upscaling tile ${processedTiles + 1}/${totalTiles}...`);

      // Extract the tile's pixel data (with overlap padding) from source canvas
      const tileImageData = srcCtx.getImageData(tile.sx, tile.sy, tile.sw, tile.sh);

      let outTileImageData, outW, outH, cropX, cropY, cropW, cropH;

      if (isLiteModel) {
        // ---- LITE MODEL PATH: pad tile up to fixed 128x128 before inference ----
        const fixedSize = ONNXEngine.LITE_MODEL_FIXED_TILE;
        const paddedImageData = this._padImageDataTo(tileImageData, fixedSize, fixedSize);
        const tensorData = this._imageDataToTensor(paddedImageData);

        const { data: outputData, dims } = await ONNXEngine.runInference(tensorData, fixedSize, fixedSize);

        const paddedOutW = dims[3];
        const paddedOutH = dims[2];
        const paddedOutImageData = this._tensorToImageData(outputData, paddedOutW, paddedOutH);

        // Crop the output back down to just the real (unpadded) tile area, scaled up
        const realOutW = tile.sw * scale;
        const realOutH = tile.sh * scale;
        outTileImageData = this._cropImageData(paddedOutImageData, 0, 0, realOutW, realOutH);

        outW = realOutW;
        outH = realOutH;
        cropX = 0;
        cropY = 0;
        cropW = tile.coreW * scale;
        cropH = tile.coreH * scale;
      } else {
        // ---- FULL MODEL PATH: dynamic tile size, as before ----
        const tensorData = this._imageDataToTensor(tileImageData);
        const { data: outputData, dims } = await ONNXEngine.runInference(tensorData, tile.sw, tile.sh);

        outH = dims[2];
        outW = dims[3];
        outTileImageData = this._tensorToImageData(outputData, outW, outH);

        cropX = tile.padLeft * scale;
        cropY = tile.padTop * scale;
        cropW = tile.coreW * scale;
        cropH = tile.coreH * scale;
      }

      // Draw this tile's output onto the correct position of the output canvas,
      // cropping away the overlap padding so tiles blend seamlessly.
      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = outW;
      tileCanvas.height = outH;
      tileCanvas.getContext('2d').putImageData(outTileImageData, 0, 0);

      outCtx.drawImage(
        tileCanvas,
        cropX, cropY, cropW, cropH,
        tile.dx * scale, tile.dy * scale, cropW, cropH
      );

      processedTiles++;

      // Yield control back to the browser so UI stays responsive
      await Utils.sleep(0);
    }

    onProgress(92, 'Applying post-processing...');

    if (settings.denoise) {
      this._applyDenoise(outCtx, outCanvas.width, outCanvas.height);
    }

    if (settings.faceEnhance) {
      onProgress(95, 'Enhancing facial details...');
      this._applySharpen(outCtx, outCanvas.width, outCanvas.height);
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
          padLeft, padTop,
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
     SIMPLE DENOISE PASS — light box-blur smoothing to reduce AI artifacts
     Operates directly on the canvas context in place.
     ------------------------------------------------------------------ */
  _applyDenoise(ctx, width, height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const radius = 1; // 3x3 kernel — light touch so detail isn't destroyed

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let rSum = 0, gSum = 0, bSum = 0, count = 0;

        for (let ky = -radius; ky <= radius; ky++) {
          for (let kx = -radius; kx <= radius; kx++) {
            const nx = x + kx;
            const ny = y + ky;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const idx = (ny * width + nx) * 4;
            rSum += src[idx];
            gSum += src[idx + 1];
            bSum += src[idx + 2];
            count++;
          }
        }

        const outIdx = (y * width + x) * 4;
        // Blend 70% original + 30% blurred to keep sharpness while reducing noise
        out[outIdx] = src[outIdx] * 0.7 + (rSum / count) * 0.3;
        out[outIdx + 1] = src[outIdx + 1] * 0.7 + (gSum / count) * 0.3;
        out[outIdx + 2] = src[outIdx + 2] * 0.7 + (bSum / count) * 0.3;
        out[outIdx + 3] = src[outIdx + 3];
      }
    }

    imageData.data.set(out);
    ctx.putImageData(imageData, 0, 0);
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
