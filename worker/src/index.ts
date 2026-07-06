import { handleApi } from "./gp/api.ts";
import { refreshAll } from "./gp/refresh.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse !== null) {
      return apiResponse;
    }
    // Non-api requests are served by the static assets binding
    // (run_worker_first is limited to /api/*), so reaching here means the
    // asset router did not handle the path.
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshAll(env));
  },
} satisfies ExportedHandler<Env>;
