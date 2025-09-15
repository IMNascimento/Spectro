export * from './colormaps.js';

/**
 * Parâmetros da lib
 */
export interface SpectrogramParams {
  sampleRate?: number;
  scaleType?: 'Linear' | 'Mel';
  fMin?: number;
  fMax?: number;
  fftSize?: number;
  windowType?: 'None' | 'Cosine' | 'Hanning' | 'BH7';
  colormapName?: string;
  canvasHeight?: number;
  nTicks?: number;
  gainDb?: number;
  rangeDb?: number;
  targetWidth?: number;
  showFrequencyAxis?: boolean;
  showTimeAxis?: boolean;        
  timeTickMinPx?: number;        
  hopSize?: number;              
}

const DEFAULT_PARAMS: Required<SpectrogramParams> = {
  sampleRate: 44100,
  scaleType: 'Linear',
  fMin: 1,
  fMax: 30000,
  fftSize: 2048,
  windowType: 'BH7',
  colormapName: 'hot',
  canvasHeight: 500,
  nTicks: 0,
  gainDb: 0,
  rangeDb: 80,
  targetWidth: 0,
  showFrequencyAxis: false,
  showTimeAxis: false,
  timeTickMinPx: 60,
  hopSize: 0,
};

export class SpectrogramGenerator {
  private params: Required<SpectrogramParams>;

  /**
   * Cria uma instância do gerador de espectrograma.
   * @param options Parâmetros de configuração; valores omitidos usam defaults.
   */
  constructor(options: SpectrogramParams = {}) {
    this.params = { ...DEFAULT_PARAMS, ...options };
  }

  /**
   * Gera o espectrograma a partir de um vetor mono (Float32Array) e retorna um canvas.
   * - Respeita `scaleType` (Linear/Mel) no mapeamento vertical.
   * - Aplica margens apenas quando eixos são exibidos.
   * - Ajusta altura para `canvasHeight` e largura para `targetWidth` (ou window.innerWidth).
   * @param audioData Amostras de áudio mono.
   * @returns HTMLCanvasElement com o espectrograma renderizado.
   */
  public generateSpectrogram(audioData: Float32Array): HTMLCanvasElement {
    const {
      sampleRate, scaleType, fMin, fMax, fftSize, windowType, colormapName,
      canvasHeight, targetWidth, showFrequencyAxis, showTimeAxis, hopSize
    } = this.params;


    const hop = hopSize > 0 ? hopSize : Math.floor(fftSize / 2);
    const spectrogramData = this.computeSpectrogram(audioData, fftSize, windowType, hop);

    const nyquist = sampleRate / 2;
    const binFreq = nyquist / (fftSize / 2);
    const i_min = Math.max(0, Math.floor(fMin / binFreq));
    const i_max = Math.min(Math.floor(fMax / binFreq), fftSize / 2);

    const { offscreenCanvas, specWidth, specHeight, globalMax, totalDurationSec } =
      this.createOffscreenCanvas(
        spectrogramData, i_min, i_max, colormapName,
        scaleType, fMin, fMax, binFreq, hop, sampleRate
      );

    const leftMargin   = showFrequencyAxis ? 60 : 0;
    const rightMargin  = showFrequencyAxis ? 10 : 0;
    const bottomMargin = showTimeAxis ? 22 : 0;
    const topMargin    = 0;

    const contentWidth = (targetWidth && targetWidth > 0 ? targetWidth : window.innerWidth) - (leftMargin + rightMargin);
    const contentHeight = canvasHeight;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width  = leftMargin + contentWidth + rightMargin;
    finalCanvas.height = topMargin + contentHeight + bottomMargin;
    const ctx = finalCanvas.getContext('2d')!;

    ctx.drawImage(
      offscreenCanvas,
      0, 0, specWidth, specHeight,
      leftMargin, topMargin, contentWidth, contentHeight
    );

    const effectiveNTicks = this.params.nTicks > 0 ? this.params.nTicks : Math.max(2, Math.floor(contentHeight / 30));
    if (showFrequencyAxis) {
      this.drawFrequencyAxis(
        ctx, scaleType, fMin, fMax,
        topMargin, contentHeight, leftMargin, effectiveNTicks
      );
    }

    if (showTimeAxis) {
      this.drawTimeAxis(
        ctx, totalDurationSec,
        leftMargin, topMargin, contentWidth, contentHeight, bottomMargin,
        this.params.timeTickMinPx
      );
    }

    return finalCanvas;
  }

  /**
   * Exporta o espectrograma como PNG em alta resolução (retorna DataURL).
   * @param audioData Dados de áudio (mesmo usado no generateSpectrogram).
   * @param upscale Fator de escala para aumentar a resolução (default: 2).
   * @returns DataURL "image/png".
   */
  public exportHighResPNG(audioData: Float32Array, upscale: number = 2): string {
    const originalCanvas = this.generateSpectrogram(audioData);
    const highResCanvas = document.createElement('canvas');
    highResCanvas.width = originalCanvas.width * upscale;
    highResCanvas.height = originalCanvas.height * upscale;
    const ctx = highResCanvas.getContext('2d')!;
    ctx.drawImage(originalCanvas, 0, 0, highResCanvas.width, highResCanvas.height);
    return highResCanvas.toDataURL('image/png');
  }

  // ===================== CORE =====================

  /**
   * Calcula o espectrograma (magnitude em dB) frame a frame.
   * @param audioData Sinal de entrada (após filtragem).
   * @param fftSize Tamanho da FFT.
   * @param windowType Tipo de janela.
   * @param hopSize Passo entre frames (amostras).
   * @returns Matriz [frame][bin] com magnitudes em dB (0..Nyquist).
   */
  private computeSpectrogram(
    audioData: Float32Array,
    fftSize: number,
    windowType: string,
    hopSize: number
  ): number[][] {
    const filteredData = this.applyFilter(audioData);
    const numFrames = Math.max(0, Math.floor((filteredData.length - fftSize) / hopSize) + 1);
    const spectrogramData: number[][] = [];

    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      const frame = filteredData.slice(start, start + fftSize);
      const windowedFrame = this.applyWindow(frame, windowType);
      const fftResult = this.myFFT(windowedFrame);
      const magArray: number[] = [];
      for (let j = 0; j < fftResult.length / 2; j++) {
        const re = fftResult[j].re;
        const im = fftResult[j].im;
        let mag = Math.sqrt(re * re + im * im);
        mag = 20 * (Math.log(mag + 1e-12) / Math.LN10); // dB
        magArray.push(mag);
      }
      spectrogramData.push(magArray);
    }
    return spectrogramData;
  }

  /**
   * Cria um canvas offscreen com o espectrograma colorido e mapeado (Linear/Mel).
   * - Normalização por faixa dinâmica (ancorada no pico global).
   * - Calcula a duração total (em segundos) para o eixo de tempo.
   * @returns Objeto com canvas offscreen e metadados: { offscreenCanvas, specWidth, specHeight, globalMax, totalDurationSec }
   */
  private createOffscreenCanvas(
    spectrogramData: number[][],
    i_min: number,
    i_max: number,
    colormapName: string,
    scaleType: 'Linear' | 'Mel',
    fMin: number,
    fMax: number,
    binFreq: number,
    hopSize: number,
    sampleRate: number
  ) {
    const specWidth = spectrogramData.length;
    const specHeight = Math.max(1, i_max - i_min);

    const totalDurationSec = (specWidth * hopSize) / sampleRate;

    let globalMax = -Infinity;
    let globalMin = +Infinity;

    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = specWidth;
    offscreenCanvas.height = specHeight;
    const offCtx = offscreenCanvas.getContext('2d')!;
    const imageData = offCtx.createImageData(specWidth, specHeight);
    const { gainDb, rangeDb } = this.params;
    const effectiveRange = rangeDb > 0 ? rangeDb : 80;

    for (let x = 0; x < specWidth; x++) {
      for (let row = 0; row < specHeight; row++) {
        let binIndex: number;
        if (scaleType === 'Mel') {
          const melMin = this.freqToMel(fMin);
          const melMax = this.freqToMel(fMax);
          const melVal = melMin + ((specHeight - row - 1) / specHeight) * (melMax - melMin);
          const freq = this.melToFreq(melVal);
          binIndex = Math.floor(freq / binFreq);
        } else {
          binIndex = i_min + (specHeight - row - 1);
        }
        binIndex = Math.min(Math.max(binIndex, i_min), i_max - 1);

        const v = (spectrogramData[x][binIndex] ?? -100) + gainDb;
        if (v > globalMax) globalMax = v;
        if (v < globalMin) globalMin = v;
      }
    }

    // Escreve imagem já normalizada e colormap
    for (let x = 0; x < specWidth; x++) {
      for (let row = 0; row < specHeight; row++) {
        let binIndex: number;
        if (scaleType === 'Mel') {
          const melMin = this.freqToMel(fMin);
          const melMax = this.freqToMel(fMax);
          const melVal = melMin + ((specHeight - row - 1) / specHeight) * (melMax - melMin);
          const freq = this.melToFreq(melVal);
          binIndex = Math.floor(freq / binFreq);
        } else {
          binIndex = i_min + (specHeight - row - 1);
        }
        binIndex = Math.min(Math.max(binIndex, i_min), i_max - 1);

        // dB com ganho e normalização ancorada no pico global
        const valueDB = (spectrogramData[x][binIndex] ?? -100) + gainDb;
        const val = Math.max(0, Math.min(1, (valueDB - (globalMax - effectiveRange)) / effectiveRange));

        let [r, g, b] = this.getColormapValue(val, colormapName);
        if (!Array.isArray([r, g, b])) {
          r = Math.floor(255 * Math.min(1, val * 2));
          g = val > 0.5 ? 255 : 0;
          b = 0;
        }

        const idx = (row * specWidth + x) * 4;
        imageData.data[idx] = r!;
        imageData.data[idx + 1] = g!;
        imageData.data[idx + 2] = b!;
        imageData.data[idx + 3] = 255;
      }
    }
    offCtx.putImageData(imageData, 0, 0);

    return { offscreenCanvas, specWidth, specHeight, globalMax, totalDurationSec };
  }

  // ===================== Eixos =====================

  /**
   * Desenha o eixo de frequências (Linear/Mel) à esquerda.
   * @param ctx Contexto 2D do canvas final.
   * @param scaleType 'Linear' ou 'Mel'.
   * @param fMin Frequência mínima (Hz).
   * @param fMax Frequência máxima (Hz).
   * @param top Topo da área útil.
   * @param height Altura da área útil.
   * @param leftMargin Largura da margem esquerda.
   * @param nTicks Número de divisões (ticks).
   */
  private drawFrequencyAxis(
    ctx: CanvasRenderingContext2D,
    scaleType: 'Linear' | 'Mel',
    fMin: number,
    fMax: number,
    top: number,
    height: number,
    leftMargin: number,
    nTicks: number
  ) {
    ctx.fillStyle = 'black';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';

    const ticks = this.generateDynamicFreqTicks(fMin, fMax, scaleType, nTicks);
    const melMin = this.freqToMel(fMin);
    const melMax = this.freqToMel(fMax);

    ticks.forEach(freq => {
      const ratio = (scaleType === 'Mel')
        ? (this.freqToMel(freq) - melMin) / (melMax - melMin)
        : (freq - fMin) / (fMax - fMin);

      const y = top + (height - ratio * height);
      const label = freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : freq.toFixed(0) + ' Hz';

      ctx.fillText(label, leftMargin - 5, y + 5);
      ctx.beginPath();
      ctx.moveTo(leftMargin - 3, y);
      ctx.lineTo(leftMargin, y);
      ctx.strokeStyle = 'black';
      ctx.stroke();
    });

    ctx.beginPath();
    ctx.moveTo(leftMargin, top);
    ctx.lineTo(leftMargin, top + height);
    ctx.strokeStyle = 'black';
    ctx.stroke();
  }

  /**
   * Desenha o eixo de tempo (s) na base do gráfico.
   * @param ctx Contexto 2D.
   * @param durationSec Duração total do áudio representado (s).
   * @param left Posição X do início do conteúdo.
   * @param top Posição Y do topo do conteúdo.
   * @param width Largura do conteúdo.
   * @param height Altura do conteúdo.
   * @param bottomMargin Tamanho da margem inferior disponível para labels.
   * @param minPx Espaço mínimo entre marcas (px).
   */
  private drawTimeAxis(
    ctx: CanvasRenderingContext2D,
    durationSec: number,
    left: number,
    top: number,
    width: number,
    height: number,
    bottomMargin: number,
    minPx: number
  ) {
    const baseY = top + height + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, baseY);
    ctx.lineTo(left + width, baseY);
    ctx.strokeStyle = 'black';
    ctx.stroke();

    const step = this.getNiceTimeStep(durationSec, width, minPx);
    for (let t = 0; t <= durationSec + 1e-9; t += step) {
      const x = left + (t / durationSec) * width;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, baseY);
      ctx.lineTo(x + 0.5, baseY - 6);
      ctx.stroke();

      const label = this.formatTimeLabel(t);
      ctx.textAlign = 'center';
      ctx.fillText(label, x, baseY + 14);
    }
  }

  /**
   * Calcula um passo "agradável" de tempo para o eixo,
   * respeitando um espaçamento mínimo em pixels.
   * @param totalSec Duração total (s).
   * @param widthPx Largura em pixels.
   * @param minPx Espaçamento mínimo entre ticks (px).
   * @returns Passo em segundos.
   */
  private getNiceTimeStep(totalSec: number, widthPx: number, minPx: number): number {
    const approxTicks = Math.max(2, Math.floor(widthPx / Math.max(30, minPx)));
    const rawStep = totalSec / approxTicks;

    const nice = [
      0.05, 0.1, 0.2, 0.5,
      1, 2, 5, 10, 15, 30,
      60, 120, 300, 600, 900, 1800, 3600
    ];
    for (const v of nice) {
      if (v >= rawStep) return v;
    }
    return 3600; // fallback
  }

  /**
   * Formata rótulos de tempo: "ms/s/mm:ss/hh:mm:ss"
   * @param sec Segundos.
   * @returns String formatada.
   */
  private formatTimeLabel(sec: number): string {
    if (sec < 60) {
      if (sec < 1) return `${sec.toFixed(2)}s`;
      if (sec < 10) return `${sec.toFixed(1)}s`;
      return `${Math.round(sec)}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ===================== Utilitários =====================

  /**
   * FFT recursiva (radix-2). Requer tamanho potência de 2.
   * @param signal Sinal de entrada (janela já aplicada).
   * @returns Array de {re, im}.
   */
  private myFFT(signal: Float32Array): Array<{ re: number; im: number }> {
    const N = signal.length;
    if (N <= 1) return [{ re: signal[0] || 0, im: 0 }];
    if (N % 2 !== 0) throw new Error('O tamanho do sinal deve ser potência de 2.');
    const half = N / 2;
    const even = new Float32Array(half);
    const odd = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      even[i] = signal[i * 2];
      odd[i] = signal[i * 2 + 1];
    }
    const fftEven = this.myFFT(even);
    const fftOdd = this.myFFT(odd);
    const combined: Array<{ re: number; im: number }> = new Array(N);
    for (let k = 0; k < half; k++) {
      const angle = (-2 * Math.PI * k) / N;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const tRe = fftOdd[k].re;
      const tIm = fftOdd[k].im;
      const expRe = cos * tRe - sin * tIm;
      const expIm = sin * tRe + cos * tIm;
      const evenRe = fftEven[k].re;
      const evenIm = fftEven[k].im;
      combined[k] = { re: evenRe + expRe, im: evenIm + expIm };
      combined[k + half] = { re: evenRe - expRe, im: evenIm - expIm };
    }
    return combined;
  }

  /**
   * Aplica janela ao frame conforme `windowType`.
   * @param signal Frame de entrada.
   * @param windowType Tipo de janela.
   * @returns Frame janelado (ou o próprio se None/default).
   */
  private applyWindow(signal: Float32Array, windowType: string): Float32Array {
    const N = signal.length;
    const out = new Float32Array(N);
    const BH7 = [0.2710514, -0.4332979392, 0.2181229995, -0.06592544639, 0.0108117421, -0.0007765848252, 0.00001388721735];

    switch (windowType) {
      case 'None':    return signal;
      case 'Cosine':  for (let i = 0; i < N; i++) out[i] = signal[i] * Math.sin((Math.PI * i) / N); break;
      case 'Hanning': for (let i = 0; i < N; i++) out[i] = signal[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / N)); break;
      case 'BH7':
        for (let i = 0; i < N; i++) {
          let w = 0;
          for (let j = 0; j < BH7.length; j++) w += BH7[j] * Math.cos((2 * Math.PI * j * i) / N);
          out[i] = signal[i] * w;
        }
        break;
      default:        return signal;
    }
    return out;
  }

  /**
   * Converte Hz -> Mel (escala de tons perceptual).
   * @param f Frequência em Hz.
   */
  private freqToMel(f: number): number {
    return 1127.01048 * Math.log(f / 700 + 1);
  }

  /**
   * Converte Mel -> Hz.
   * @param m Valor em Mel.
   */
  private melToFreq(m: number): number {
    return 700 * (Math.exp(m / 1127.01048) - 1);
  }

  /**
   * Gera ticks de frequência (Linear ou Mel) entre f_min e f_max.
   * @param f_min Hz mínimo.
   * @param f_max Hz máximo.
   * @param scaleType 'Linear' ou 'Mel'.
   * @param nTicks quantidade de divisões (mín. 2).
   * @returns Array de frequências para rotular o eixo.
   */
  private generateDynamicFreqTicks(
    f_min: number, f_max: number, scaleType: 'Linear' | 'Mel', nTicks: number
  ): number[] {
    if (nTicks < 2) nTicks = 2;
    const ticks: number[] = [];
    if (scaleType === 'Mel') {
      const melMin = this.freqToMel(f_min);
      const melMax = this.freqToMel(f_max);
      const melStep = (melMax - melMin) / (nTicks - 1);
      for (let i = 0; i < nTicks; i++) ticks.push(this.melToFreq(melMin + i * melStep));
    } else {
      const step = (f_max - f_min) / (nTicks - 1);
      for (let i = 0; i < nTicks; i++) ticks.push(f_min + i * step);
    }
    return ticks;
  }

  /**
   * Resolve a cor [r,g,b] (0..255) para um valor normalizado [0..1].
   * Espera uma função colormap no escopo global: `window[colormapName](t)`.
   * @param value Valor normalizado (0..1).
   * @param colormapName Nome do colormap (ex.: 'hot').
   * @returns Array [r,g,b].
   */
  private getColormapValue(value: number, colormapName: string): number[] {
    const fn = (window as any)[colormapName];
    if (typeof fn === 'function') {
      const res = fn(value);
      if (Array.isArray(res) && res.length >= 3) return res;
    }
    return [255 * value, 0, 0];
  }

  // ===================== Filtros =====================

  /**
   * Aplica filtragem FIR conforme parâmetros opcionais em this.params:
   * - filterType: 'none' | 'lowpass' | 'highpass' | 'bandpass' | 'notch'
   * - filterCutoffs: [cutoff] ou [lowCut, highCut] (Hz)
   * Observação: parâmetros não estão tipados no SpectrogramParams desta versão,
   * logo é feito cast para `any` aqui.
   * @param signal Sinal de entrada.
   * @returns Sinal filtrado (ou original, se não configurado).
   */
  private applyFilter(signal: Float32Array): Float32Array {
    const { filterType, filterCutoffs, sampleRate } = this.params as any;
    if (!filterType || filterType === 'none') return signal;

    const kernelSize = 101;
    let kernel: Float32Array;

    if (filterType === 'lowpass' && filterCutoffs && filterCutoffs.length >= 1) {
      kernel = this.generateLowpassKernel(filterCutoffs[0], sampleRate, kernelSize);
    } else if (filterType === 'highpass' && filterCutoffs && filterCutoffs.length >= 1) {
      kernel = this.generateHighpassKernel(filterCutoffs[0], sampleRate, kernelSize);
    } else if ((filterType === 'bandpass' || filterType === 'notch') && filterCutoffs && filterCutoffs.length >= 2) {
      const [lowCut, highCut] = filterCutoffs;
      kernel = (filterType === 'bandpass')
        ? this.generateBandpassKernel(lowCut, highCut, sampleRate, kernelSize)
        : this.generateNotchKernel(lowCut, highCut, sampleRate, kernelSize);
    } else {
      return signal;
    }

    const out = new Float32Array(signal.length);
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < signal.length; i++) {
      let sum = 0;
      for (let j = 0; j < kernelSize; j++) {
        const k = i - mid + j;
        if (k >= 0 && k < signal.length) sum += signal[k] * kernel[j];
      }
      out[i] = sum;
    }
    return out;
  }

  /**
   * Kernel FIR passa-baixa (windowed-sinc + Hamming).
   * @param cutoff Hz de corte.
   * @param sampleRate Hz.
   * @param kernelSize Tamanho ímpar do kernel.
   * @returns Coeficientes FIR.
   */
  private generateLowpassKernel(cutoff: number, sampleRate: number, kernelSize: number): Float32Array {
    const kernel = new Float32Array(kernelSize);
    const fc = cutoff / sampleRate;
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) {
      const n = i - mid;
      kernel[i] = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      kernel[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (kernelSize - 1)); // Hamming
    }
    return kernel;
  }

  /**
   * Kernel FIR passa-alta = delta - lowpass(cutoff).
   * @param cutoff Hz de corte.
   * @param sampleRate Hz.
   * @param kernelSize Tamanho ímpar do kernel.
   * @returns Coeficientes FIR.
   */
  private generateHighpassKernel(cutoff: number, sampleRate: number, kernelSize: number): Float32Array {
    const low = this.generateLowpassKernel(cutoff, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) kernel[i] = (i === mid ? 1 : 0) - low[i];
    return kernel;
  }

  /**
   * Kernel FIR passa-banda = lowpass(highCut) - lowpass(lowCut).
   * @param lowCut Hz de corte inferior.
   * @param highCut Hz de corte superior.
   * @param sampleRate Hz.
   * @param kernelSize Tamanho ímpar do kernel.
   * @returns Coeficientes FIR.
   */
  private generateBandpassKernel(lowCut: number, highCut: number, sampleRate: number, kernelSize: number): Float32Array {
    const lpH = this.generateLowpassKernel(highCut, sampleRate, kernelSize);
    const lpL = this.generateLowpassKernel(lowCut, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    for (let i = 0; i < kernelSize; i++) kernel[i] = lpH[i] - lpL[i];
    return kernel;
  }

  /**
   * Kernel FIR rejeita-banda (notch) = delta - bandpass(lowCut, highCut).
   * @param lowCut Hz de corte inferior da banda rejeitada.
   * @param highCut Hz de corte superior da banda rejeitada.
   * @param sampleRate Hz.
   * @param kernelSize Tamanho ímpar do kernel.
   * @returns Coeficientes FIR.
   */
  private generateNotchKernel(lowCut: number, highCut: number, sampleRate: number, kernelSize: number): Float32Array {
    const bp = this.generateBandpassKernel(lowCut, highCut, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) kernel[i] = (i === mid ? 1 : 0) - bp[i];
    return kernel;
  }
}
