export class LocalQueueRunner {
  constructor() {
    this.pending = [];
    this.active = 0;
    this.runningKeys = new Set();
    this.idleWaiters = [];
  }

  enqueue(key, task) {
    if (this.runningKeys.has(key)) {
      return;
    }

    this.runningKeys.add(key);
    this.pending.push(async () => {
      try {
        await task();
      } finally {
        this.runningKeys.delete(key);
      }
    });
    queueMicrotask(() => {
      void this.drain();
    });
  }

  async drain() {
    if (this.active > 0) {
      return;
    }

    while (this.pending.length > 0) {
      const nextTask = this.pending.shift();
      if (!nextTask) {
        continue;
      }

      this.active += 1;
      try {
        await nextTask();
      } finally {
        this.active -= 1;
      }
    }

    if (this.active === 0 && this.pending.length === 0) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  async waitForIdle() {
    if (this.active === 0 && this.pending.length === 0) {
      return;
    }

    await new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
}
