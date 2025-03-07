export * from './colormaps.js';

/**
 * Interface de parâmetros para gerar espectrogramas.
 * Adicionamos gainDb e rangeDb para controle de ganho e intervalo em dB,
 * targetWidth para definir a largura final desejada, e showFrequencyAxis para exibir o eixo.
 */
export interface SpectrogramParams {
  sampleRate?: number;          // Taxa de amostragem (Hz)
  scaleType?: 'Linear' | 'Mel'; // Tipo de escala no eixo de frequência
  fMin?: number;                // Freq. mínima (Hz)
  fMax?: number;                // Freq. máxima (Hz)
  fftSize?: number;             // Tamanho da FFT
  windowType?: 'None' | 'Cosine' | 'Hanning' | 'BH7';
  colormapName?: string;        // Nome do colormap (ex.: 'hot', 'jet', etc.)
  canvasHeight?: number;        // Altura final do canvas (targetHeight)
  nTicks?: number;              // Quantidade de ticks (divisões) no eixo de frequência; se 0, será calculado dinamicamente
  gainDb?: number;              // Deslocamento de dB (exemplo: +20 dB)
  rangeDb?: number;             // Intervalo de dB para normalização (exemplo: 80 dB)
  targetWidth?: number;         // Largura final desejada (se 0 ou não definida, usa window.innerWidth)
  showFrequencyAxis?: boolean;  // Se true, exibe o eixo de frequência (default: false)
}

/**
 * Parâmetros padrão.
 */
const DEFAULT_PARAMS: Required<SpectrogramParams> = {
  sampleRate: 44100,
  scaleType: 'Mel',
  fMin: 1,
  fMax: 20000,
  fftSize: 8192,
  windowType: 'BH7',
  colormapName: 'hot',
  canvasHeight: 500,  
  nTicks: 20,         
  gainDb: 20,
  rangeDb: 80,
  targetWidth: 0,     // 0 indica que usaremos window.innerWidth
  showFrequencyAxis: false
};

/**
 * Classe principal que gera o espectrograma.
 * Você pode instanciar e chamar generateSpectrogram() para obter um canvas pronto.
 */
export class SpectrogramGenerator {
  private params: Required<SpectrogramParams>;

  constructor(options: SpectrogramParams = {}) {
    this.params = { ...DEFAULT_PARAMS, ...options };
  }

  /**
   * Gera o espectrograma a partir de um array de áudio (single channel).
   * Retorna um HTMLCanvasElement contendo o espectrograma desenhado.
   */
  public generateSpectrogram(audioData: Float32Array): HTMLCanvasElement {
    const { sampleRate, scaleType, fMin, fMax, fftSize, windowType, colormapName, canvasHeight, targetWidth, showFrequencyAxis } = this.params;
  
    const spectrogramData = this.computeSpectrogram(audioData, fftSize, windowType);
  
    const nyquist = sampleRate / 2;
    const binFreq = nyquist / (fftSize / 2);
    const i_min = Math.floor(fMin / binFreq);
    const i_max = Math.floor(fMax / binFreq);
  
    const { offscreenCanvas, specWidth, specHeight } =
      this.createOffscreenCanvas(spectrogramData, i_min, i_max, colormapName);
  
    const leftMargin = showFrequencyAxis ? 60 : 0;
    const rightMargin = showFrequencyAxis ? 10 : 0;
  
    const finalWidth =
      (targetWidth && targetWidth > 0 ? targetWidth : window.innerWidth) - (leftMargin + rightMargin);
    const finalHeight = canvasHeight;
  
    const effectiveNTicks = this.params.nTicks > 0 ? this.params.nTicks : Math.max(2, Math.floor(finalHeight / 30));
  
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = leftMargin + finalWidth + rightMargin;
    finalCanvas.height = finalHeight;
    const ctx = finalCanvas.getContext('2d')!;
  
    ctx.drawImage(
      offscreenCanvas,
      0, 0, specWidth, specHeight,
      leftMargin, 0, finalWidth, finalHeight
    );

    if (showFrequencyAxis) {
      this.drawFrequencyAxis(ctx, scaleType, fMin, fMax, finalHeight, leftMargin, effectiveNTicks);
    }
  
    return finalCanvas;
  }

  /**
   * Método extra para exportar o espectrograma gerado como uma imagem PNG de alta resolução.
   * O parâmetro upscale define o fator de ampliação (padrão: 2).
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


  private computeSpectrogram(audioData: Float32Array, fftSize: number, windowType: string): number[][] {
    const hopSize = fftSize / 2;
    const numFrames = Math.floor((audioData.length - fftSize) / hopSize) + 1;
    const spectrogramData: number[][] = [];

    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      const frame = audioData.slice(start, start + fftSize);
      const windowedFrame = this.applyWindow(frame, windowType);
      const fftResult = this.myFFT(windowedFrame);
      const magArray: number[] = [];
      for (let j = 0; j < fftResult.length / 2; j++) {
        const re = fftResult[j].re;
        const im = fftResult[j].im;
        let mag = Math.sqrt(re * re + im * im);
        mag = 20 * (Math.log(mag + 1e-12) / Math.LN10);
        magArray.push(mag);
      }
      spectrogramData.push(magArray);
    }
    return spectrogramData;
  }

  private createOffscreenCanvas(
    spectrogramData: number[][],
    i_min: number,
    i_max: number,
    colormapName: string
  ) {
    const specWidth = spectrogramData.length;
    const specHeight = Math.max(1, i_max - i_min);

    let globalMax = -Infinity;
    for (let x = 0; x < spectrogramData.length; x++) {
      for (let y = i_min; y < i_max; y++) {
        if (spectrogramData[x][y] > globalMax) {
          globalMax = spectrogramData[x][y];
        }
      }
    }
    if (globalMax === -Infinity) {
      globalMax = -100;
    }

    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = specWidth;
    offscreenCanvas.height = specHeight;
    const offscreenCtx = offscreenCanvas.getContext('2d')!;
    const imageData = offscreenCtx.createImageData(specWidth, specHeight);

    const { gainDb, rangeDb } = this.params;

    for (let x = 0; x < specWidth; x++) {
      for (let row = 0; row < specHeight; row++) {
        const binIndex = i_min + (specHeight - row - 1);
        let valueDB = spectrogramData[x][binIndex] ?? -100;
        valueDB += gainDb;
        let val = valueDB / rangeDb;
        val = Math.max(0, Math.min(val, 1));

        let colorArray = this.getColormapValue(val, colormapName);
        if (!Array.isArray(colorArray) || colorArray.length < 3) {
          colorArray = [
            Math.floor(255 * Math.min(1, val * 2)),
            val > 0.5 ? 255 : 0,
            0,
          ];
        }
        const [r, g, b] = colorArray;
        const idx = (row * specWidth + x) * 4;
        imageData.data[idx] = r;
        imageData.data[idx + 1] = g;
        imageData.data[idx + 2] = b;
        imageData.data[idx + 3] = 255;
      }
    }
    offscreenCtx.putImageData(imageData, 0, 0);

    return { offscreenCanvas, specWidth, specHeight, globalMax };
  }
/**
 * Desenha o eixo de frequências (vertical) no canvas final.
 */
  private drawFrequencyAxis(
    ctx: CanvasRenderingContext2D,
    scaleType: 'Linear' | 'Mel',
    fMin: number,
    fMax: number,
    finalHeight: number,
    leftMargin: number,
    nTicks: number
  ) {
    ctx.fillStyle = 'black';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';

    const freqTicks = this.generateDynamicFreqTicks(fMin, fMax, scaleType, nTicks);

    const melMin = this.freqToMel(fMin);
    const melMax = this.freqToMel(fMax);

    freqTicks.forEach(freq => {
      let ratio: number;
      if (scaleType === 'Mel') {
        const melVal = this.freqToMel(freq);
        ratio = (melVal - melMin) / (melMax - melMin);
      } else {
        ratio = (freq - fMin) / (fMax - fMin);
      }
      const y = finalHeight - ratio * finalHeight;
      const label = freq >= 1000
        ? (freq / 1000).toFixed(2) + ' kHz'
        : freq.toFixed(0) + ' Hz';

      ctx.fillText(label, leftMargin - 5, y + 5);
      ctx.beginPath();
      ctx.moveTo(leftMargin - 3, y);
      ctx.lineTo(leftMargin, y);
      ctx.strokeStyle = 'black';
      ctx.stroke();
    });

    ctx.beginPath();
    ctx.moveTo(leftMargin, 0);
    ctx.lineTo(leftMargin, finalHeight);
    ctx.strokeStyle = 'black';
    ctx.stroke();
  }


  private myFFT(signal: Float32Array): Array<{ re: number; im: number }> {
    const N = signal.length;
    if (N <= 1) return [{ re: signal[0] || 0, im: 0 }];
    if (N % 2 !== 0) {
      throw new Error('O tamanho do sinal deve ser potência de 2.');
    }
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

  private applyWindow(signal: Float32Array, windowType: string): Float32Array {
    const N = signal.length;
    const out = new Float32Array(N);
    const BH7 = [
      0.2710514,
      -0.4332979392,
      0.2181229995,
      -0.06592544639,
      0.0108117421,
      -0.0007765848252,
      0.00001388721735
    ];
    switch (windowType) {
      case 'None':
        return signal;
      case 'Cosine':
        for (let i = 0; i < N; i++) {
          out[i] = signal[i] * Math.sin((Math.PI * i) / N);
        }
        break;
      case 'Hanning':
        for (let i = 0; i < N; i++) {
          out[i] = signal[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
        }
        break;
      case 'BH7':
        for (let i = 0; i < N; i++) {
          let w = 0;
          for (let j = 0; j < BH7.length; j++) {
            w += BH7[j] * Math.cos((2 * Math.PI * j * i) / N);
          }
          out[i] = signal[i] * w;
        }
        break;
      default:
        return signal;
    }
    return out;
  }

  private freqToMel(f: number): number {
    return 1127.01048 * Math.log(f / 700 + 1);
  }

  private melToFreq(m: number): number {
    return 700 * (Math.exp(m / 1127.01048) - 1);
  }

  private generateDynamicFreqTicks(
    f_min: number,
    f_max: number,
    scaleType: 'Linear' | 'Mel',
    nTicks: number
  ): number[] {
    const ticks: number[] = [];

    if (nTicks < 2) {
      nTicks = 2;
    }

    if (scaleType === 'Mel') {
      const melMin = this.freqToMel(f_min);
      const melMax = this.freqToMel(f_max);
      const melStep = (melMax - melMin) / (nTicks - 1);
      for (let i = 0; i < nTicks; i++) {
        const melVal = melMin + i * melStep;
        ticks.push(this.melToFreq(melVal));
      }
    } else {
      const step = (f_max - f_min) / (nTicks - 1);
      for (let i = 0; i < nTicks; i++) {
        ticks.push(f_min + i * step);
      }
    }
    return ticks;
  }
/**
 * Obtém cor (R,G,B) de 0..255 para um valor normalizado [0..1].
 * Espera que existam funções colormap no escopo global (window).
 * Ajuste se precisar de outra forma de resolver colormaps.
 */
  private getColormapValue(value: number, colormapName: string): number[] {
    const fn = (window as any)[colormapName];
    if (typeof fn === 'function') {
      const result = fn(value);
      return Array.isArray(result) ? result : [0, 0, 0];
    }
    return [255 * value, 0, 0];
  }
}

