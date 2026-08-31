export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Minimal OpenAI-chat-compatible client for CaDS Tutor's dialog generation.
 * Talks to a litellm proxy (or anything else exposing the same
 * /chat/completions shape). Deliberately dumb: no retries, no streaming, no
 * SDK dependency - the platform's only correctness requirement for this
 * layer is "send exactly the grounded prompt, return exactly what came
 * back", not resilience engineering.
 *
 * baseUrl MUST be https - a plain-http litellm endpoint URL has already
 * caused a real, hard-to-diagnose 401 in this project's own firmware-lab
 * (looked like a credentials problem, wasn't one).
 */
export class LlmClient {
  constructor(private readonly options: LlmClientOptions) {
    if (!options.baseUrl.startsWith("https://")) {
      throw new Error(`LlmClient baseUrl must be https:// (got "${options.baseUrl}") - see the http->https 401 lesson in firmware-lab`);
    }
  }

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${response.statusText} - ${body}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response had no message content");
    }
    return content;
  }
}
