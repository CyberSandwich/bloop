// The Workflow that converts one file version (ADR 0019), carrying only keys and status. The converter change fills it;
// until then an instance ends at once, so a binding without code behind it cannot hold work.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ConvertParams } from "../../shared/protocol.ts";
import type { Env } from "../env.ts";

export class ConvertWorkflow extends WorkflowEntrypoint<Env, ConvertParams> {
  override async run(_event: WorkflowEvent<ConvertParams>, _step: WorkflowStep): Promise<{ status: "skipped" }> {
    return { status: "skipped" };
  }
}
