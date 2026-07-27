
/* ==========================================================================
   AI VIDEO ENHANCER — GPU POST-PROCESSING MODULE (js/postprocess.js)
   Runs extra enhancement filters (Sharpen, Edge Enhancement, Texture/
   Clarity boost) entirely on the GPU via WebGL instead of manual JS
   pixel loops — this matters a lot on 4x-upscaled images/frames, which
   can be tens of millions of pixels. A JS loop at that size is slow;
   a GPU shader processes every pixel in parallel and is dramatically
   faster, using the device's graphics hardware instead of the CPU.
   ========================================================================== */

'use strict';

const PostProcess = {

  _gl: null,
  _canvas: null,
  _programs: {},

  /* ------------------------------------------------------------------
     INTERNAL: (RE)CREATE THE OFFSCREEN WEBGL CONTEXT AT A GIVEN SIZE
     ------------------------------------------------------------------ */
  _initGL(width, height) {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
    }
    this._canvas.width = width;
    this._canvas.height = height;

    if (!this._gl) {
      this._gl = this._canvas.getContext('webgl', { premultipliedAlpha: false })
        || this._canvas.getContext('experimental-webgl', { premultipliedAlpha: false });
      if (!this._gl) {
        throw new Error('WebGL is not supported on this device — GPU filters (Sharpen/Edge/Texture) are unavailable here.');
      }
    }
    return this._gl;
  },

  _compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('GPU shader compile error: ' + info);
    }
    return shader;
  },

  _getProgram(gl, key, fragmentSrc) {
    if (this._programs[key]) return this._programs[key];

    const vertexSrc = `
      attribute vec2 aPos;
      varying vec2 vUv;
      void main() {
        vUv = (aPos + 1.0) * 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const vs = this._compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('GPU program link error: ' + gl.getProgramInfoLog(program));
    }

    this._programs[key] = program;
    return program;
  },

  /* ------------------------------------------------------------------
     RUN A 3x3 CONVOLUTION FILTER (Sharpen or Edge Enhancement) ON A
     CANVAS, ENTIRELY ON THE GPU. Returns a new canvas with the result.
     kernelName: 'sharpen' | 'edge'
     amount: 0 (no effect) to 1 (full strength)
     ------------------------------------------------------------------ */
  applyConvolution(sourceCanvas, kernelName, amount = 0.6) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const gl = this._initGL(width, height);

    const kernels = {
      // Classic sharpen kernel — boosts the center pixel relative to its neighbors
      sharpen: [
         0, -1,  0,
        -1,  5, -1,
         0, -1,  0
      ],
      // Stronger kernel that emphasizes edges/outlines specifically
      edge: [
        -1, -1, -1,
        -1,  9, -1,
        -1, -1, -1
      ]
    };
    const kernel = kernels[kernelName];
    if (!kernel) throw new Error(`Unknown convolution kernel "${kernelName}"`);

    const fragmentSrc = `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform vec2 uTexel;
      uniform float uAmount;
      uniform float uKernel[9];

      void main() {
        vec4 sum = vec4(0.0);
        int idx = 0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y)) * uTexel;
            sum += texture2D(uTexture, vUv + offset) * uKernel[idx];
            idx++;
          }
        }
        vec4 original = texture2D(uTexture, vUv);
        gl_FragColor = mix(original, vec4(sum.rgb, original.a), uAmount);
      }
    `;

    const program = this._getProgram(gl, 'convolution', fragmentSrc);
    gl.useProgram(program);

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

    gl.viewport(0, 0, width, height);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / width, 1 / height);
    gl.uniform1f(gl.getUniformLocation(program, 'uAmount'), amount);
    gl.uniform1fv(gl.getUniformLocation(program, 'uKernel'), kernel);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Copy the GPU result into a fresh 2D canvas for the caller to use
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    outCanvas.getContext('2d').drawImage(this._canvas, 0, 0);

    gl.deleteTexture(texture);
    gl.deleteBuffer(posBuffer);

    return outCanvas;
  },

  /* ------------------------------------------------------------------
     TEXTURE / CLARITY BOOST — brings out fine surface detail (skin
     texture, fabric, hair strands) using a local micro-contrast trick
     similar to the "Clarity"/"Texture" slider in photo editors. Native
     canvas blur+contrast+overlay compositing — hardware-accelerated by
     the browser, no manual pixel loop needed.
     ------------------------------------------------------------------ */
  applyTextureBoost(ctx, width, height, amount = 0.35) {
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d').drawImage(ctx.canvas, 0, 0);

    ctx.save();
    ctx.filter = 'blur(3px) contrast(1.4)';
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = amount;
    ctx.drawImage(original, 0, 0);
    ctx.restore();
  }
};
