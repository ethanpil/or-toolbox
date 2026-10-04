// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../errors';
import {
  compositeMasked,
  createRaster,
  featherInside,
  type Mask,
  maskOverlay,
  maskToRaster,
  type RasterImage,
} from './image';
import type * as ImageAsync from './image-async';
import { MAX_WORKER_FAILURES } from './image-async';
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
    // As a real postMessage: the worker gets a copy, and transferred buffers are emptied on the page.
    this.sent.push({ request: structuredClone(request, { transfer }), transfer });
  }

  /** The worker itself fails (script blocked, crashed). */
  fail(): void {
    this.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

function stub(): void {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}

describe('isolateImage with a worker', () => {
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
    expect(second?.sent[0]?.request).toMatchObject({ options: { size: 31 } });
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

  it('runs the job on the page when its worker fails, and starts a new worker for the next job', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const job = isolateImage(photo(), { size: 24 });
    const [worker] = FakeWorker.instances;
    worker?.fail();
    expect(worker?.terminated).toBe(true);
    expect((await job).image.width).toBe(24);

    const next = isolateImage(photo(), { size: 25 });
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1];
    second?.reply({ id: second.sent[0]?.request.id ?? -1, ok: true, result: resultFor(25) });
    expect((await next).image.width).toBe(25);
  });

  it(`gives up on workers after ${MAX_WORKER_FAILURES} failures with no answer between them`, async () => {
    stub();
    const { isolateImage } = await freshModule();
    const failNext = async (size: number): Promise<void> => {
      const job = isolateImage(photo(), { size });
      FakeWorker.instances.at(-1)?.fail();
      expect((await job).image.width).toBe(size);
    };
    await failNext(20);
    // An answer in between starts the count again.
    const answered = isolateImage(photo(), { size: 21 });
    const worker = FakeWorker.instances[1];
    worker?.reply({ id: worker.sent[0]?.request.id ?? -1, ok: true, result: resultFor(21) });
    await answered;
    worker?.fail(); // idle, between jobs
    await failNext(22);
    await failNext(23);
    expect(FakeWorker.instances).toHaveLength(MAX_WORKER_FAILURES + 1);
    // The page does the work from now on.
    expect((await isolateImage(photo(), { size: 24 })).image.width).toBe(24);
    expect(FakeWorker.instances).toHaveLength(MAX_WORKER_FAILURES + 1);
  });

  it('copies the pixels for a worker that has not answered yet, so the page can run the job if it fails to load', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const source = photo();
    const job = isolateImage(source, { size: 24 }, { transfer: true });
    const [worker] = FakeWorker.instances;
    expect(worker?.sent[0]?.transfer).toEqual([]);
    expect(source.data.length).toBe(60 * 40 * 4);
    worker?.fail();
    expect((await job).image.data).toEqual(isolateRaster(photo(), { size: 24 }).image.data);
  });

  it('rejects a transferred job whose worker dies, instead of running it on emptied pixels', async () => {
    stub();
    const { isolateImage } = await freshModule();
    const first = isolateImage(photo(), { size: 30 });
    const [worker] = FakeWorker.instances;
    worker?.reply({ id: worker.sent[0]?.request.id ?? -1, ok: true, result: resultFor(30) });
    await first;

    const moved = photo();
    const job = isolateImage(moved, { size: 31 }, { transfer: true });
    expect(moved.data.length).toBe(0); // handed over to the worker
    worker?.fail();
    await expect(job).rejects.toSatisfy(
      (error) =>
        error instanceof Error &&
        error.name === 'InvalidInputError' &&
        /stopped/.test(error.message),
    );
    // Trying again uses a new worker.
    void isolateImage(photo(), { size: 32 });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('runs on the page when the Worker constructor throws, and tries again for the next job', async () => {
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
    expect((await isolateImage(photo(), { size: 23 })).image.width).toBe(23);
  });
});

describe('the Image editor operations', () => {
  /** A 50 x 40 picture with a gradient, and a mask with a 20 x 16 block marked. */
  const picture = (): RasterImage => {
    const img = createRaster(50, 40);
    for (let p = 0; p < 50 * 40; p++) img.data.set([p % 256, (p * 7) % 256, 90, 255], p * 4);
    return img;
  };
  const block = (): Mask => {
    const mask: Mask = { width: 50, height: 40, data: new Uint8Array(50 * 40) };
    for (let y = 12; y < 28; y++) mask.data.fill(255, y * 50 + 15, y * 50 + 35);
    return mask;
  };
  const result = (): RasterImage => createRaster(50, 40, '#c83214');

  it('give exactly what the pure functions give (on the page, without workers)', async () => {
    const ops = await freshModule();
    expect((await ops.maskOverlayAsync(picture(), block(), '#FF00FF', 0.5)).data).toEqual(
      maskOverlay(picture(), block(), '#FF00FF', 0.5).data,
    );
    expect((await ops.maskToRasterAsync(block())).data).toEqual(maskToRaster(block()).data);
    expect((await ops.featherInsideAsync(block(), 4)).data).toEqual(featherInside(block(), 4).data);
    expect(
      (await ops.compositeMaskedAsync(picture(), result(), block(), { feather: 4 })).data,
    ).toEqual(compositeMasked(picture(), result(), featherInside(block(), 4)).data);
    expect((await ops.compositeMaskedAsync(picture(), result(), block())).data).toEqual(
      compositeMasked(picture(), result(), block()).data,
    );
  });

  it('send their inputs to the worker, transfer them once it has answered, and can be aborted', async () => {
    stub();
    const ops = await freshModule();
    const first = ops.featherInsideAsync(block(), 3, { transfer: true });
    const [worker] = FakeWorker.instances;
    expect(worker?.sent[0]).toMatchObject({
      request: { op: 'featherInside', radius: 3 },
      transfer: [],
    });
    worker?.reply({
      id: worker.sent[0]?.request.id ?? -1,
      ok: true,
      result: featherInside(block(), 3),
    });
    expect((await first).data).toEqual(featherInside(block(), 3).data);

    const original = picture();
    const mask = block();
    const answer = result();
    const composite = ops.compositeMaskedAsync(
      original,
      answer,
      mask,
      { feather: 6 },
      { transfer: true },
    );
    const sent = worker?.sent[1];
    expect(sent?.request).toMatchObject({ op: 'compositeMasked', feather: 6 });
    expect(sent?.transfer).toHaveLength(3);
    expect([original.data.length, answer.data.length, mask.data.length]).toEqual([0, 0, 0]);

    const controller = new AbortController();
    const marked = ops.maskOverlayAsync(picture(), block(), '#FF00FF', 0.5, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(marked).rejects.toSatisfy(isAbortError);
    expect(worker?.terminated).toBe(false); // it was still waiting
    worker?.reply({ id: sent?.request.id ?? -1, ok: true, result: createRaster(50, 40) });
    expect((await composite).width).toBe(50);
  });

  it('run on the page when the worker fails', async () => {
    stub();
    const ops = await freshModule();
    const job = ops.maskToRasterAsync(block(), { transfer: true });
    FakeWorker.instances[0]?.fail();
    expect((await job).data).toEqual(maskToRaster(block()).data);
  });

  it('transfer a pixel buffer once when two inputs share it', async () => {
    stub();
    const ops = await freshModule();
    const warmUp = ops.maskToRasterAsync(block());
    const [worker] = FakeWorker.instances;
    worker?.reply({ id: worker.sent[0]?.request.id ?? -1, ok: true, result: createRaster(50, 40) });
    await warmUp;
    const same = picture();
    void ops.compositeMaskedAsync(same, same, block(), {}, { transfer: true });
    expect(worker?.sent[1]?.transfer).toHaveLength(2);
  });
});
