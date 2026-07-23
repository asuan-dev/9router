import { checkinEmitter } from "@/shared/services/activityScheduler";

export const dynamic = "force-dynamic";

/**
 * SSE: push check-in badge fields right after upstream status/claim responds.
 * No polling — only emits when the scheduler has an API result.
 */
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, onUpdate: null, keepalive: null };

  const stream = new ReadableStream({
    start(controller) {
      state.onUpdate = (payload) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          state.closed = true;
          if (state.onUpdate) checkinEmitter.off("update", state.onUpdate);
          clearInterval(state.keepalive);
        }
      };

      checkinEmitter.on("checkin", state.onUpdate);

      // Keepalive only — not a data probe
      state.keepalive = setInterval(() => {
        if (state.closed) {
          clearInterval(state.keepalive);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
          if (state.onUpdate) checkinEmitter.off("checkin", state.onUpdate);
        }
      }, 25000);
    },
    cancel() {
      state.closed = true;
      if (state.onUpdate) checkinEmitter.off("checkin", state.onUpdate);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
