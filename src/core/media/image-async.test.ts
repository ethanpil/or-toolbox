// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../errors';
import { createRaster, type RasterImage } from './image';
import type * as ImageAsync from './image-async';
import type { IsolateResult } from './image-pipeline';
import { isolateRaster } from './image-pipeline';
import type { WorkerRequest, WorkerResponse } from './image-worker';

/** A fresh copy of the module: its worker and queue are module state. */
async function freshModule(): Promise<typeof ImageAsync> {
  vi.resetModules();
  return import('./image-async');
}

function photo(width = 60, height = 40): RasterImage {
  const img = createRaster(width, height, '#fbfbfb');
  for (let y = 10; y < 30; y++) {
    for (let x = 15; x < 45; x++) img.data.set([20, 80, 160, 255], (y * width + x) * 4);
  }
  return img;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isolateImage without workers (the page runs the pipeline itself)', () => {
  it('gives the same result as the pure pipeline', async () => {
    const { isolateImage } = await freshModule();
    const source = photo();
    const result = await isolateImage(source, { size: 80 });
    const expected = isolateRaster(source, { size: 80 });
    expect(result.image.data).toEqual(expected.image.data);
    expect(result.box).toEqual(expected.box);
    expect(result.check).toEqual(expected.check);
  });

  it('keeps the source usable: nothing is transferred unless asked', async () => {
    const { isolateImage } = await freshModule();
    const source = photo();
    await isolateImage(source, { size: 40 });
    await isolateImage(source, { size: 40, margin: 0.2 });
    expect(source.data.length).toBe(60 * 40 * 4);
  });

  it('runs jobs one after another, each with its own result', async () => {
    const { isolateImage } = await freshModule();
    const results = await Promise.all([30, 40, 50].map((size) => isolateImage(photo(), { size })));
    expect(results.map((result) => result.image.width)).toEqual([30, 40, 50]);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const { isolateImage } = await freshModule();
    const controller = new AbortController();
    controller.abort();
    await expect(isolateImage(photo(), {}, { signal: controller.signal })).rejects.toSatisfy(
      isAbortError,
    );
  });

  it('removes a waiting job when it is aborted, and the others still run', async () => {
    const { isolateImage } = await freshModule();
    const controller = new AbortController();
    const first = isolateImage(photo(), { size: 30 });
    const second = isolateImage(photo(), { size: 31 }, { signal: controller.signal });
    const third = isolateImage(photo(), { size: 32 });
    controller.abort();
    await expect(second).rejects.toSatisfy(isAbortError);
    expect((await first).image.width).toBe(30);
    expect((await third).image.width).toBe(32);
  });

  it('abandons the running job when it is aborted, and goes on with the next', async () => {
    const { isolateImage } = await freshModule();
    const controller = new AbortController();
    const running = isolateImage(photo(), { size: 30 }, { signal: controller.signal });
    const next = isolateImage(photo(), { size: 33 });
    controller.abort();
    await expect(running).rejects.toSatisfy(isAbortError);
    expect((await next).image.width).toBe(33);
  });

  it('rejects everything pending when the worker is disposed', async () => {
    const { isolateImage, disposeImageWorker } = await freshModule();
    const a = isolateImage(photo(), {});
    const b = isolateImage(photo(), {});
    disposeImageWorker();
    await expect(a).rejects.toSatisfy(isAbortError);
    await expect(b).rejects.toSatisfy(isAbortError);
    // And the module still works afterwards.
    expect((await isolateImage(photo(), { size: 20 })).image.width).toBe(20);
  });
});

/** A worker that records what it is sent and answers when the test says so. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly sent: { request: WorkerRequest; transfer: Transferable[] }[] = [];
  readonly url: URL;
  readonly options: WorkerOptions;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(request: WorkerRequest, transfer: Transferable[] = []): void {
    this.sent.push({ request, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

describe('isolateImage with a worker', () => {
  const stub = (): void => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  };
  const resultFor = (size: number): IsolateResult => isolateRaster(photo(), { size });

  it('starts one module worker from image-worker.ts and sends it one job at a time', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const first = isolateImage(photo(), { size: 30 });
    const second = isolateImage(photo(), { size: 31 });

    const [worker] = FakeWorker.instances;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker?.options).toEqual({ type: 'module' });
    expect(String(worker?.url)).toMatch(/image-worker/);
    expect(worker?.sent).toHaveLength(1); // the second waits

    const sent = worker?.sent[0]?.request;
    expect(sent).toMatchObject({ op: 'isolate', options: { size: 30 } });
    worker?.reply({ id: sent?.id ?? -1, ok: true, result: resultFor(30) });
    expect((await first).image.width).toBe(30);

    expect(worker?.sent).toHaveLength(2);
    const next = worker?.sent[1]?.request;
    worker?.reply({ id: next?.id ?? -1, ok: true, result: resultFor(31) });
    expect((await second).image.width).toBe(31);
  });

  it('copies the pixels by default and transfers them when asked', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const copied = photo();
    const moved = photo();
    void isolateImage(copied, {});
    const [worker] = FakeWorker.instances;
    expect(worker?.sent[0]?.transfer).toEqual([]);
    worker?.reply({ id: worker.sent[0]?.request.id ?? -1, ok: true, result: resultFor(20) });
    await Promise.resolve();

    void isolateImage(moved, {}, { transfer: true });
    expect(worker?.sent[1]?.transfer).toEqual([moved.data.buffer]);
  });

  it('turns a failure inside the worker into a rejection', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const job = isolateImage(photo(), {});
    const [worker] = FakeWorker.instances;
    worker?.reply({ id: worker.sent[0]?.request.id ?? -1, ok: false, message: 'boom' });
    await expect(job).rejects.toThrow('boom');
  });

  it('terminates the worker when the running job is aborted, and starts a new one for the next', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const controller = new AbortController();
    const running = isolateImage(photo(), { size: 30 }, { signal: controller.signal });
    const next = isolateImage(photo(), { size: 31 });
    const [first] = FakeWorker.instances;

    controller.abort();
    await expect(running).rejects.toSatisfy(isAbortError);
    expect(first?.terminated).toBe(true);

    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1];
    expect(second?.sent[0]?.request.options).toEqual({ size: 31 });
    second?.reply({ id: second.sent[0]?.request.id ?? -1, ok: true, result: resultFor(31) });
    expect((await next).image.width).toBe(31);
  });

  it('does not touch the worker when a waiting job is aborted', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const controller = new AbortController();
    void isolateImage(photo(), { size: 30 });
    const waiting = isolateImage(photo(), { size: 31 }, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toSatisfy(isAbortError);
    expect(FakeWorker.instances[0]?.terminated).toBe(false);
    expect(FakeWorker.instances[0]?.sent).toHaveLength(1);
  });

  it('runs on the page when the worker cannot start', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const job = isolateImage(photo(), { size: 24 });
    const [worker] = FakeWorker.instances;
    worker?.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
    expect(worker?.terminated).toBe(true);
    expect((await job).image.width).toBe(24);
    // Later jobs do not try the worker again.
    expect((await isolateImage(photo(), { size: 25 })).image.width).toBe(25);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('runs on the page when the Worker constructor throws', async () => {
    FakeWorker.instances = [];
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    const { isolateImage } = await freshModule();
    expect((await isolateImage(photo(), { size: 22 })).image.width).toBe(22);
  });
});
