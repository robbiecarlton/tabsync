import { describe, expect, it, vi } from 'vitest';
import { ApiError, HttpSyncApi, NetworkError } from '../src/lib/api';

const creds = { profileId: 'P'.repeat(22), authToken: 't'.repeat(43) };

function respond(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(async () =>
    status === 304
      ? new Response(null, { status })
      : new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

describe('HttpSyncApi', () => {
  it('sends the profileId.token bearer and JSON bodies, trimming the base URL', async () => {
    const fetchFn = respond(201, { id: 'x' });
    await new HttpSyncApi('http://localhost:8787/', creds, fetchFn).upload({
      id: 'x',
      createdAt: '2026-10-22T12:00:00.000Z',
      kind: 'auto',
      blob: 'AAAA',
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/v1/snapshots');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${creds.profileId}.${creds.authToken}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init!.body as string)).toMatchObject({ id: 'x', kind: 'auto' });
  });

  it('register posts the credentials', async () => {
    const fetchFn = respond(201, { profileId: creds.profileId });
    await new HttpSyncApi('http://s', creds, fetchFn).register();
    expect(fetchFn.mock.calls[0]![0]).toBe('http://s/v1/profiles');
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string)).toEqual(creds);
  });

  it('latest maps 200, 304 and 404 no_snapshots', async () => {
    const snap = { id: 'a', blob: 'b' };
    expect(await new HttpSyncApi('http://s', creds, respond(200, snap)).latest()).toEqual({
      status: 'ok',
      snapshot: snap,
    });

    const notModified = respond(304);
    expect(await new HttpSyncApi('http://s', creds, notModified).latest('abc')).toEqual({
      status: 'not-modified',
    });
    expect(notModified.mock.calls[0]![1]!.headers).toMatchObject({ 'If-None-Match': '"abc"' });

    expect(
      await new HttpSyncApi(
        'http://s',
        creds,
        respond(404, { error: 'no_snapshots', message: 'none' }),
      ).latest(),
    ).toEqual({ status: 'empty' });
  });

  it('list unwraps the snapshots array', async () => {
    const api = new HttpSyncApi('http://s', creds, respond(200, { snapshots: [{ id: 'a' }] }));
    expect(await api.list()).toEqual([{ id: 'a' }]);
  });

  it('turns error responses into ApiError with the server code and message', async () => {
    const api = new HttpSyncApi(
      'http://s',
      creds,
      respond(401, { error: 'unauthorized', message: 'Nope' }),
    );
    const err = await api.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'Nope',
      transient: false,
    });
  });

  it('marks 5xx and 429 as transient, and copes with non-JSON error bodies', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('Bad gateway', { status: 502 }));
    const err = (await new HttpSyncApi('http://s', creds, fetchFn)
      .list()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.transient).toBe(true);
    expect(err.message).toBe('Server responded 502');
    expect(new ApiError(429, 'rate_limited', '').transient).toBe(true);
  });

  it('wraps fetch failures in NetworkError', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new HttpSyncApi('http://s', creds, fetchFn).list()).rejects.toThrow(NetworkError);
  });
});
