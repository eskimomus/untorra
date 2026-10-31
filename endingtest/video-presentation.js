export function captionVisibleAt(time, { fps = 30, firstFrame = 68, lastFrame = 176 } = {}) {
  if (!Number.isFinite(time) || time < 0) return false;
  const frame = Math.floor(time * fps + 0.000001);
  return frame >= firstFrame && frame <= lastFrame;
}

export class VideoCaption {
  constructor({ fps = 30, firstFrame = 68, lastFrame = 176, onFrame = () => {}, requestFrame = callback => requestAnimationFrame(callback), cancelFrame = handle => cancelAnimationFrame(handle) } = {}) {
    this.range = { fps, firstFrame, lastFrame };
    this.onFrame = onFrame;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.handle = null;
    this.epoch = 0;
  }

  bind(video, element) {
    this.cancel();
    this.video = video;
    this.element = element;
    this.refresh();
  }

  show(time) {
    if (!this.element) return;
    const hidden = !captionVisibleAt(time, this.range);
    if (this.element.hidden !== hidden) this.element.hidden = hidden;
    this.onFrame(time, !hidden);
  }

  refresh() {
    if (!this.video || !this.element) return;
    this.show(this.video.currentTime);
    this.schedule();
  }

  schedule() {
    if (this.handle !== null || !this.video || !this.element || this.video.paused || this.video.ended) return;
    const epoch = this.epoch;
    const receiveFrame = (timestamp, metadata) => {
      if (epoch !== this.epoch) return;
      this.handle = null;
      this.show(metadata?.mediaTime ?? this.video.currentTime);
      this.schedule();
    };
    this.native = typeof this.video.requestVideoFrameCallback === 'function';
    this.handle = this.native ? this.video.requestVideoFrameCallback(receiveFrame) : this.requestFrame(receiveFrame);
  }

  cancel() {
    this.epoch += 1;
    if (this.handle !== null) {
      if (this.native) this.video.cancelVideoFrameCallback?.(this.handle);
      else this.cancelFrame(this.handle);
    }
    if (this.element) this.element.hidden = true;
    this.handle = null;
    this.video = null;
    this.element = null;
  }
}

