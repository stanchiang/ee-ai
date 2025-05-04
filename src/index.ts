import type { Ai } from "@cloudflare/ai";

export interface Env {
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }

    /* body sent by the React client */
    const { messages, image } = (await request.json()) as {
      messages: { role: string; content: string }[];
      image?: string;                           // data‑URL from FileReader
    };

    /* If an image is attached, merge it with the user’s last message so the
       model sees BOTH the text and the picture in one turn. */
    if (image) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        last.content = [
          { type: "text", text: last.content },
          { type: "image_url", image_url: { url: image } },
        ];
      }
    }

    const stream = await env.AI.run(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      { messages, stream: true },
    );

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "access-control-allow-origin": "*", // CORS for local dev
      },
    });
  },
} satisfies ExportedHandler<Env>;
