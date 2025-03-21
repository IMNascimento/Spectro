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
  filterType?: 'none' | 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  filterCutoffs?: number[]; // Para lowpass/highpass use [cutoff]; para bandpass/notch, use [lowCut, highCut]
  enablePitchDetection?: boolean; // Habilita extração de pitch (não implementado)
  enableHarmonicsExtraction?: boolean; // Habilita extração de harmônicos (não implementado)
}

/**
 * Parâmetros padrão.
 */
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
  rangeDb: 0,
  targetWidth: 0,     // 0 indica que usaremos window.innerWidth
  showFrequencyAxis: false,
  filterType: 'none',
  filterCutoffs: [],
  enablePitchDetection: false,
  enableHarmonicsExtraction: false,
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
    const filteredData = this.applyFilter(audioData);
    const hopSize = fftSize / 2;
    const numFrames = Math.floor((filteredData.length - fftSize) / hopSize) + 1;
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

  /**
   * Método para detecção da frequência fundamental (pitch tracking).
   * Utiliza um algoritmo simples de autocorrelação para encontrar o lag com
   * maior correlação e, assim, estimar a frequência fundamental.
   * Retorna a frequência fundamental em Hz.
   */
  public detectPitch(audioData: Float32Array): number {
    const sampleRate = this.params.sampleRate;
    // Define limites de lag com base nas frequências mínima e máxima
    const minLag = Math.floor(sampleRate / this.params.fMax);
    const maxLag = Math.floor(sampleRate / this.params.fMin);
    let bestLag = 0;
    let bestCorrelation = -Infinity;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < audioData.length - lag; i++) {
        sum += audioData[i] * audioData[i + lag];
      }
      if (sum > bestCorrelation) {
        bestCorrelation = sum;
        bestLag = lag;
      }
    }
    // Evita divisão por zero
    if (bestLag === 0) return 0;
    return sampleRate / bestLag;
  }

  /**
   * Método para extração de harmônicos.
   * Primeiro, detecta a frequência fundamental e, em seguida, calcula os harmônicos
   * como múltiplos inteiros da frequência fundamental, respeitando o limite máximo fMax.
   * Retorna um objeto contendo a frequência fundamental e um array com os harmônicos.
   */
  public extractHarmonics(audioData: Float32Array): { fundamental: number; harmonics: number[] } {
    const fundamental = this.detectPitch(audioData);
    const harmonics: number[] = [];
    // Extrai harmônicos a partir do segundo (n=2) até um máximo de 10 ou até ultrapassar fMax
    for (let n = 2; n <= 10; n++) {
      const harmonicFreq = fundamental * n;
      if (harmonicFreq > this.params.fMax) break;
      harmonics.push(harmonicFreq);
    }
    return { fundamental, harmonics };
  }


/**
 * Aplica filtragem FIR no sinal de entrada de acordo com os parâmetros definidos.
 * Suporta os filtros: lowpass, highpass, bandpass e notch.
 */
private applyFilter(signal: Float32Array): Float32Array {
  const { filterType, filterCutoffs, sampleRate } = this.params;
  if (!filterType || filterType === 'none') {
    return signal;
  }

  // Definindo o tamanho do kernel (deve ser ímpar para manter simetria)
  const kernelSize = 101;
  let kernel: Float32Array;

  if (filterType === 'lowpass' && filterCutoffs && filterCutoffs.length >= 1) {
    kernel = this.generateLowpassKernel(filterCutoffs[0], sampleRate, kernelSize);
  } else if (filterType === 'highpass' && filterCutoffs && filterCutoffs.length >= 1) {
    kernel = this.generateHighpassKernel(filterCutoffs[0], sampleRate, kernelSize);
  } else if ((filterType === 'bandpass' || filterType === 'notch') && filterCutoffs && filterCutoffs.length >= 2) {
    const lowCut = filterCutoffs[0];
    const highCut = filterCutoffs[1];
    if (filterType === 'bandpass') {
      kernel = this.generateBandpassKernel(lowCut, highCut, sampleRate, kernelSize);
    } else {
      kernel = this.generateNotchKernel(lowCut, highCut, sampleRate, kernelSize);
    }
  } else {
    // Se os parâmetros forem insuficientes, retorne o sinal sem filtragem
    return signal;
  }

  // Convolução simples do sinal com o kernel
  const output = new Float32Array(signal.length);
  const mid = Math.floor(kernelSize / 2);
  for (let i = 0; i < signal.length; i++) {
    let sum = 0;
    for (let j = 0; j < kernelSize; j++) {
      const k = i - mid + j;
      if (k >= 0 && k < signal.length) {
        sum += signal[k] * kernel[j];
      }
    }
    output[i] = sum;
  }
  return output;
}

  /**
   * Gera um kernel FIR para um filtro passa-baixa (lowpass) usando o método windowed-sinc.
   * @param cutoff Frequência de corte (Hz).
   * @param sampleRate Taxa de amostragem (Hz).
   * @param kernelSize Tamanho do kernel (deve ser ímpar).
   */
  private generateLowpassKernel(cutoff: number, sampleRate: number, kernelSize: number): Float32Array {
    const kernel = new Float32Array(kernelSize);
    const fc = cutoff / sampleRate; // Frequência normalizada
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) {
      const n = i - mid;
      // Função sinc: sin(2πfc n)/(πn); trata n = 0 separadamente.
      kernel[i] = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      // Aplica janela de Hamming
      kernel[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (kernelSize - 1));
    }
    return kernel;
  }

  /**
   * Gera um kernel FIR para um filtro passa-alta (highpass).
   * A ideia é subtrair o kernel lowpass de um delta (impulso unitário).
   * @param cutoff Frequência de corte (Hz).
   * @param sampleRate Taxa de amostragem (Hz).
   * @param kernelSize Tamanho do kernel (deve ser ímpar).
   */
  private generateHighpassKernel(cutoff: number, sampleRate: number, kernelSize: number): Float32Array {
    const lowpassKernel = this.generateLowpassKernel(cutoff, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) {
      // Delta: 1 no centro, 0 caso contrário
      kernel[i] = (i === mid ? 1 : 0) - lowpassKernel[i];
    }
    return kernel;
  }

  /**
   * Gera um kernel FIR para um filtro passa-banda (bandpass).
   * O filtro passa-banda é obtido pela diferença entre dois filtros passa-baixa,
   * com frequências de corte superior e inferior.
   * @param lowCut Frequência de corte inferior (Hz).
   * @param highCut Frequência de corte superior (Hz).
   * @param sampleRate Taxa de amostragem (Hz).
   * @param kernelSize Tamanho do kernel (deve ser ímpar).
   */
  private generateBandpassKernel(lowCut: number, highCut: number, sampleRate: number, kernelSize: number): Float32Array {
    const lowpassHigh = this.generateLowpassKernel(highCut, sampleRate, kernelSize);
    const lowpassLow = this.generateLowpassKernel(lowCut, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    for (let i = 0; i < kernelSize; i++) {
      kernel[i] = lowpassHigh[i] - lowpassLow[i];
    }
    return kernel;
  }

  /**
   * Gera um kernel FIR para um filtro notch (bandstop).
   * O filtro notch é obtido subtraindo o filtro passa-banda de um delta (impulso unitário).
   * @param lowCut Frequência de corte inferior (Hz) da banda a ser rejeitada.
   * @param highCut Frequência de corte superior (Hz) da banda a ser rejeitada.
   * @param sampleRate Taxa de amostragem (Hz).
   * @param kernelSize Tamanho do kernel (deve ser ímpar).
   */
  private generateNotchKernel(lowCut: number, highCut: number, sampleRate: number, kernelSize: number): Float32Array {
    const bandpassKernel = this.generateBandpassKernel(lowCut, highCut, sampleRate, kernelSize);
    const kernel = new Float32Array(kernelSize);
    const mid = Math.floor(kernelSize / 2);
    for (let i = 0; i < kernelSize; i++) {
      kernel[i] = (i === mid ? 1 : 0) - bandpassKernel[i];
    }
    return kernel;
  }
}

