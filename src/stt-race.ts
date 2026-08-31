/**
 * Races the same audio against every known whisper-service endpoint (see
 * src/cli/whisper-service.ts) and returns whichever responds first - per
 * the platform's own design: no single deployment is a hard dependency,
 * and whichever host currently has the fastest absolute reaction time wins
 * automatically, without the caller needing to know which one that is.
 *
 * Deliberately built on Promise.any(), not Promise.race(): race() settles
 * on the first promise to settle AT ALL (success or failure), which would
 * make one endpoint being briefly down enough to fail the whole race even
 * when a second endpoint would have answered fine a moment later. any()
 * settles on the first FULFILLMENT and only rejects once every endpoint has
 * failed - exactly "use whichever succeeds fastest, tolerate the rest being
 * slow or down".
 */

export interface WhisperEndpoint {
  /** Base URL, e.g. "http://localhost:8756" or "https://whisper-abc.bunsenbrenner.org". */
  url: string;
  /** Sent as "Authorization: Bearer <apiKey>" if the endpoint requires one. */
  apiKey?: string;
  /** A short label for logging/diagnostics - defaults to `url`. */
  label?: string;
}

export interface RaceResult {
  text: string;
  wonBy: string;
  latencyMs: number;
}

export class TranscribeRaceError extends Error {
  constructor(public readonly failures: Array<{ endpoint: string; error: string }>) {
    super(`All ${failures.length} whisper-service endpoint(s) failed:\n  - ` + failures.map((f) => `${f.endpoint}: ${f.error}`).join("\n  - "));
  }
}

async function callOne(
  endpoint: WhisperEndpoint,
  audio: Buffer | Uint8Array,
  language: string,
  signal: AbortSignal
): Promise<RaceResult> {
  const label = endpoint.label ?? endpoint.url;
  const started = Date.now();
  const url = new URL("/transcribe", endpoint.url);
  url.searchParams.set("lang", language);

  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (endpoint.apiKey) headers["authorization"] = `Bearer ${endpoint.apiKey}`;

  const res = await fetch(url, { method: "POST", headers, body: audio, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} returned ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { text?: string; error?: string };
  if (typeof data.text !== "string") {
    throw new Error(`${label} returned no text: ${JSON.stringify(data)}`);
  }
  return { text: data.text, wonBy: label, latencyMs: Date.now() - started };
}

export interface TranscribeRaceOptions {
  language?: string;
  /** Aborts every still-pending endpoint once one has won (default true) - the loser(s) would
   * otherwise keep burning CPU on a whisper-cli run nobody will use. */
  cancelLosers?: boolean;
}

/**
 * Sends `audio` to every endpoint in `endpoints` concurrently and resolves with the first one
 * to succeed. Throws TranscribeRaceError (carrying every endpoint's individual failure) only if
 * ALL of them fail. Requires at least one endpoint.
 */
export async function transcribeRace(
  audio: Buffer | Uint8Array,
  endpoints: WhisperEndpoint[],
  options: TranscribeRaceOptions = {}
): Promise<RaceResult> {
  if (endpoints.length === 0) {
    throw new Error("transcribeRace: at least one endpoint is required");
  }
  const language = options.language ?? "auto";
  const cancelLosers = options.cancelLosers ?? true;
  const controller = new AbortController();

  const failures: Array<{ endpoint: string; error: string }> = [];
  const attempts = endpoints.map((endpoint) =>
    callOne(endpoint, audio, language, controller.signal).catch((err) => {
      failures.push({ endpoint: endpoint.label ?? endpoint.url, error: err instanceof Error ? err.message : String(err) });
      throw err;
    })
  );

  try {
    const result = await Promise.any(attempts);
    if (cancelLosers) controller.abort();
    return result;
  } catch {
    throw new TranscribeRaceError(failures);
  }
}
