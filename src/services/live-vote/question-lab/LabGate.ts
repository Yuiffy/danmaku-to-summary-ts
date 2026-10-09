export class LabBusy extends Error {}
/** Keep the slot until the underlying operation exits, even after its caller timed out. */
export class LabGate {
  private active?: AbortController;
  private nextAt = 0;
  constructor(private readonly timeoutMs = 90000, private readonly cooldownMs = 2000) {}
  async run<T>(task: (signal: AbortSignal) => Promise<T>, caller: AbortSignal): Promise<T> {
    if (this.active || Date.now() < this.nextAt) throw new LabBusy('Another local query is running');
    caller.throwIfAborted();
    const controller = new AbortController();
    this.active = controller;
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(new Error('Local query cancelled or timed out')); };
    const timer = setTimeout(abort, this.timeoutMs);
    caller.addEventListener('abort', abort, { once: true });
    const work = Promise.resolve().then(() => task(controller.signal)).finally(() => {
      clearTimeout(timer); caller.removeEventListener('abort', abort);
      this.active = undefined; this.nextAt = Date.now() + this.cooldownMs;
    });
    return Promise.race([work, aborted]);
  }
  stop(): void { this.active?.abort(); }
}
