/*  Cloudflare Worker  –  ASCII‑only circuit chat
    ------------------------------------------------
    • Adds a strict system prompt: “reply only with ASCII art”.
    • Streams the model, sanitising *only* the text field inside each
      SSE JSON envelope (so control bytes are never stripped).
*/

import type { Ai } from "@cloudflare/ai";

export interface Env {
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }

    /* ────── request body ────── */
    const { history, images = [], text } = (await request.json()) as {
      history: { role: string; content: string }[];
      images?: string[]; // data‑URLs
      text: string;
    };

    /* helper: stream one AI turn into ctrl */
    const streamOne = async (
      msgParts: any[],
      ctrl: ReadableStreamDefaultController
    ) => {
      const messages = [
        ...history,
        { role: "user", content: msgParts },
        {
          role: "system",
          content: [
            "You are a helpful electrical engineer.",
            "",
            "⚠️ If the request is vague fill in the gaps always assume simplified assumptions",
            "⚠️ ALWAYS reply with *only* ASCII art representing a complete, functional electronic circuit using standard components (e.g., resistors, capacitors, ICs, transistors, diodes, etc.).",
            "⚠️ Label each component with its **type and value** (e.g., R1 1kΩ, C1 10µF, 555 Timer, etc.).",
            "⚠️ Show **connections with lines**, and **nest or box components** when appropriate (e.g., for ICs).",
            "⚠️ Do NOT reply with explanations, text, captions, or code fences. Just ASCII art.",
            "⚠️ If you must refuse, reply with exactly: ERROR",
          ].join("\n"),
        },
      ];

      const aiStream = await env.AI.run(
        "@cf/meta/llama-4-scout-17b-16e-instruct",
        { messages, stream: true }
      );
      const reader = aiStream.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        /* value looks like:  data: {"response":"..."}\n\n */
        const chunkStr = decoder.decode(value, { stream: false });
        const match = chunkStr.match(/^data:\s*(\{.*\})/);
        if (!match) {
          // Unexpected line (keep passthrough just in case)
          ctrl.enqueue(value);
          continue;
        }

        const obj = JSON.parse(match[1]);

        /* 🧹 sanitise ONLY the model text */
        obj.response = obj.response.replace(/```[\s\S]*?```/g, "");

        const cleanLine = "data: " + JSON.stringify(obj) + "\n\n";
        ctrl.enqueue(encoder.encode(cleanLine));
      }
    };

    /* ────── combined SSE stream ────── */
    const stream = new ReadableStream({
      start: async (ctrl) => {
        /* 1️⃣ image‑plus‑text turns (one per picture) */
        for (const url of images) {
          await streamOne(
            [
              { type: "image_url", image_url: { url } },
              { type: "text", text },
            ],
            ctrl
          );
          // Visual pause so the client can separate images
          ctrl.enqueue(
            new TextEncoder().encode('data: {"response":"\\n"}\n\n')
          );
        }

        /* 2️⃣ pure text turn if there were no images */
        if (images.length === 0) {
          await streamOne([{ type: "text", text }], ctrl);
        }

        /* done */
        ctrl.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        ctrl.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "access-control-allow-origin": "*", // dev CORS
      },
    });
  },
} satisfies ExportedHandler<Env>;
