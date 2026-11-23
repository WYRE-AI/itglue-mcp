import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITGlueClient } from "../mcp-server.js";
import { ITGlueRateLimitError, RATE_LIMIT_RETRY, parseRetryAfter, retryDelayMs } from "../rate-limit.js";

function limited(retryAfter?: string, status = 429): Response {
  return new Response(JSON.stringify({ errors: [{ status: String(status), title: "Too Many Requests" }] }), {
    status,
    headers: { "Content-Type": "application/vnd.api+json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
  });
}

function ok(data: unknown = []): Response {
  return new Response(JSON.stringify({ data, meta: {} }), {
    status: 200,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

describe("parseRetryAfter", () => {
  it("reads delay-seconds, rounding fractions up", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(" 0 ")).toBe(0);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:07 GMT", now)).toBe(7000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
  });

  it("ignores missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-3")).toBeUndefined();
  });
});

describe("retryDelayMs", () => {
  it("uses Retry-After when given, up to 10 s", () => {
    expect(retryDelayMs(0, 3000)).toBe(3000);
    expect(retryDelayMs(0, 0)).toBe(0);
    expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs)).toBe(10_000);
  });

  it("does not retry without Retry-After (no invented backoff)", () => {
    expect(retryDelayMs(0, undefined)).toBeUndefined();
  });

  it("retries at most once", () => {
    expect(RATE_LIMIT_RETRY.maxRetries).toBe(1);
    expect(retryDelayMs(1, 1000)).toBeUndefined();
  });

  it("does not wait longer than maxWaitMs", () => {
    expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs + 1)).toBeUndefined();
  });
});

describe("ITGlueClient retry on 429", () => {
  const fetchMock = vi.fn();
  const client = new ITGlueClient({ apiKey: "test-key", baseUrl: "https://api.example.com" });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits for Retry-After and returns the retried success", async () => {
    fetchMock.mockResolvedValueOnce(limited("2")).mockResolvedValueOnce(ok());

    const pending = client.request("/organizations");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives each attempt a fresh request (new timeout signal)", async () => {
    fetchMock.mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(ok());

    const pending = client.request("/organizations");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(first.signal).toBeInstanceOf(AbortSignal);
    expect(first.signal).not.toBe(second.signal);
  });

  it("does not replay a write on a 429; the error says how long to wait", async () => {
    for (const call of [
      () => client.post("/organizations", { data: {} }),
      () => client.patch("/organizations/1", { data: {} }),
      () => client.delete("/organizations/1"),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(limited("2"));
      await expect(call()).rejects.toThrow(/IT Glue API error \(429\).*HTTP 429.*Try again in 2 s\./);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after maxRetries and reports HTTP 429 with the last Retry-After", async () => {
    fetchMock.mockImplementation(async () => limited("3"));

    const pending = client.request("/organizations");
    const assertion = expect(pending).rejects.toThrow(/IT Glue API error \(429\).*HTTP 429.*Try again in 3 s\./);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_RETRY.maxRetries + 1);
  });

  it("does not wait for a long Retry-After, and defaults to 60 s without one", async () => {
    fetchMock.mockResolvedValueOnce(limited("120"));
    await expect(client.request("/organizations")).rejects.toThrow(/Try again in 120 s\./);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No Retry-After: no retry at all, and the 60 s default in both places.
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => limited());
    const error = await client.request("/organizations").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ITGlueRateLimitError);
    expect((error as Error).message).toMatch(/HTTP 429.*Try again in 60 s\./);
    expect((error as ITGlueRateLimitError).retryAfterSeconds).toBe(60);
  });

  it("reports Retry-After: 0 as 1 s, in the message and in retryAfterSeconds", async () => {
    fetchMock.mockImplementation(async () => limited("0"));

    const pending = client.request("/organizations").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const error = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_RETRY.maxRetries + 1);
    expect((error as Error).message).toMatch(/Try again in 1 s\./);
    expect((error as ITGlueRateLimitError).retryAfterSeconds).toBe(1);
  });

  it("retries a 503 only when it carries Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(limited(undefined, 503));
    await expect(client.request("/organizations")).rejects.toThrow(/IT Glue API error \(503\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(limited("1", 503)).mockResolvedValueOnce(ok());
    const pending = client.request("/organizations");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not replay a write on a 503, even with Retry-After (it may have been applied)", async () => {
    for (const call of [
      () => client.post("/organizations", { data: {} }),
      () => client.patch("/organizations/1", { data: {} }),
      () => client.delete("/organizations/1"),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(limited("1", 503));
      await expect(call()).rejects.toThrow(/IT Glue API error \(503\): Try again in 1 s\./);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // A GET with the same 503 is still retried.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(limited("1", 503)).mockResolvedValueOnce(ok());
    const pending = client.request("/organizations");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the Retry-After of a 503 it stops retrying, and leaves a bare 503 unchanged", async () => {
    fetchMock.mockResolvedValueOnce(limited("30", 503));
    await expect(client.request("/organizations")).rejects.toThrow(/^IT Glue API error \(503\): Try again in 30 s\./);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => limited("2", 503));
    const pending = client.request("/organizations");
    const assertion = expect(pending).rejects.toThrow(/IT Glue API error \(503\): Try again in 2 s\./);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_RETRY.maxRetries + 1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(client.request("/organizations")).rejects.toThrow(/^IT Glue API error \(503\): down$/);
  });

  it("does not retry other errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(client.request("/organizations")).rejects.toThrow(/IT Glue API error \(500\): nope/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
