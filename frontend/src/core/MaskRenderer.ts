/**
 * 蒙版渲染：把全分辨率选区蒙版着色为半透明覆盖层（按版本号增量刷新）。
 */

export class MaskRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private version = -1;
  private readonly color: string;
  private readonly opacity: number;

  constructor(color = '#00e5ff', opacity = 0.42) {
    this.color = color;
    this.opacity = opacity;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** 蒙版版本变化时刷新着色层 */
  update(mask: HTMLCanvasElement, version: number): void {
    if (version === this.version && this.canvas.width === mask.width) return;
    if (this.canvas.width !== mask.width || this.canvas.height !== mask.height) {
      this.canvas.width = mask.width;
      this.canvas.height = mask.height;
    }
    const c = this.ctx;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.globalAlpha = this.opacity;
    c.fillStyle = this.color;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask, 0, 0);
    c.globalCompositeOperation = 'source-over';
    this.version = version;
  }
}
