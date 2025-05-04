/*  Cloudflare Worker – Image‑to‑Circuit Chat
    Emits three ASCII blocks (schematic, PCB, BOM) delimited by === MARKERS ===
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
            "⚠️ ALWAYS reply with ASCII art **only** – no prose, no code fences.",
            "",
            "✂️ **Output format (MANDATORY)**",
            "=== SCHEMATIC ===",
            "(ASCII circuit diagram with labelled parts)",
            "=== PCB ===",
            "(ASCII representation of the PCB layout)",
            "=== BOM ===",
            "(plain ASCII list of components, one per line: Ref  Value  Part‑type)",
            "",
            "Keep lines under 120 chars, use spaces/ASCII box‑drawing as needed.",
            "If you must refuse, reply with exactly: ERROR",
            "",
            "📷 **Image handling rule**: if the user supplies an image, assume it shows",
            "the device to clone; design a circuit that replicates its main function.",
          ].join("\n"),
        },
      ];

      const aiStream = await env.AI.run(
        "@cf/meta/llama-4-scout-17b-16e-instruct",
        { messages, stream: true, max_tokens: 9999, seed: 1 }
      );
      const reader = aiStream.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        /* each chunk looks like:  data: {"response":"..."}\n\n */
        const chunkStr = decoder.decode(value, { stream: false });
        const match = chunkStr.match(/^data:\s*(\{.*\})/);
        if (!match) {
          // Unexpected line – passthrough
          ctrl.enqueue(value);
          continue;
        }

        const obj = JSON.parse(match[1]);

        /* 🧹 sanitise ONLY the model text (strip any accidental code‑fences) */
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
          const safeText =
            text.trim() ||
            "Design a schematic / PCB / BOM for this device (ASCII blocks only)";
          await streamOne(
            [
              { type: "image_url", image_url: { url } },
              { type: "text", text: safeText },
            ],
            ctrl
          );
          // visual pause so the client can separate images
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
