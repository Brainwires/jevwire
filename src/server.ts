/**
 * MCP wiring.
 *
 * The server owns transport concerns only: schema registration, turning a
 * thrown error into an `isError` result, and emitting both a structured result
 * and a text rendering of it (clients differ in which they show). All behavior
 * lives in `src/tools/*`, which know nothing about MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MISSING_API_KEY_MESSAGE, type Config } from "./config.js";
import type { DecisionModel } from "./decision/types.js";
import { describeError } from "./jev/errors.js";
import * as evaluateTool from "./tools/evaluate.js";
import * as gateActionTool from "./tools/gate-action.js";
import * as listModelsTool from "./tools/list-models.js";
import * as nextStepTool from "./tools/next-step.js";
import * as pickTool from "./tools/pick.js";
import * as rankTool from "./tools/rank.js";
import * as verifyTool from "./tools/verify.js";
import type { ToolConfig } from "./tools/shared.js";

export const SERVER_NAME = "jevwire";
export const SERVER_VERSION = "0.6.0";

/** Read-only, but every tool reaches an external API. */
const ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

function ok(output: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output as { [key: string]: unknown },
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build the server. `model` is `null` when no API key was configured: the
 * server still starts and every tool answers with an actionable `isError`,
 * because an MCP client that cannot start the server shows a transport failure
 * instead of the explanation the user needs.
 */
export function createServer(model: DecisionModel | null, config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );

  const toolConfig: ToolConfig = {
    model: config.model,
    thresholds: config.thresholds,
    maxConcurrency: config.maxConcurrency,
    maxConcurrencyExplicit: config.maxConcurrencyExplicit,
    // The one place the file-reading tools learn which directory they are
    // confined to. Everything under `src/files` refuses to leave it.
    files: { root: config.projectRoot },
  };

  /** Never let a key reach a client, even if an upstream body echoed it. */
  const redact = (message: string): string =>
    config.apiKey === null || config.apiKey.length < 8
      ? message
      : message.split(config.apiKey).join("[redacted]");

  function wrap<I, O extends object>(
    run: (model: DecisionModel, input: I, config: ToolConfig, signal?: AbortSignal) => Promise<O>,
  ): (input: I, extra: { signal?: AbortSignal }) => Promise<CallToolResult> {
    return async (input, extra) => {
      if (model === null) return fail(MISSING_API_KEY_MESSAGE);
      try {
        return ok(await run(model, input, toolConfig, extra.signal));
      } catch (error) {
        return fail(redact(describeError(error)));
      }
    };
  }

  server.registerTool(
    evaluateTool.name,
    {
      description: evaluateTool.description,
      inputSchema: evaluateTool.inputShape,
      outputSchema: evaluateTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(evaluateTool.run),
  );

  server.registerTool(
    rankTool.name,
    {
      description: rankTool.description,
      inputSchema: rankTool.inputShape,
      outputSchema: rankTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(rankTool.run),
  );

  server.registerTool(
    pickTool.name,
    {
      description: pickTool.description,
      inputSchema: pickTool.inputShape,
      outputSchema: pickTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(pickTool.run),
  );

  server.registerTool(
    verifyTool.name,
    {
      description: verifyTool.description,
      inputSchema: verifyTool.inputShape,
      outputSchema: verifyTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(verifyTool.run),
  );

  server.registerTool(
    gateActionTool.name,
    {
      description: gateActionTool.description,
      inputSchema: gateActionTool.inputShape,
      outputSchema: gateActionTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(gateActionTool.run),
  );

  server.registerTool(
    nextStepTool.name,
    {
      description: nextStepTool.description,
      inputSchema: nextStepTool.inputShape,
      outputSchema: nextStepTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(nextStepTool.run),
  );

  server.registerTool(
    listModelsTool.name,
    {
      description: listModelsTool.description,
      inputSchema: listModelsTool.inputShape,
      outputSchema: listModelsTool.outputShape,
      annotations: ANNOTATIONS,
    },
    wrap(listModelsTool.run),
  );

  return server;
}
