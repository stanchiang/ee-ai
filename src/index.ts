import type { Ai } from "@cloudflare/ai";

// declare your bindings
export interface Env {
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }

    // messages come straight from the React client
    const { messages } = (await request.json()) as {
      messages: { role: string; content: string }[];
    };

    // stream from Workers AI
    const stream = await env.AI.run(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      { messages, stream: true }
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        // optional CORS for local dev
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
} satisfies ExportedHandler<Env>;
