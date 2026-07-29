#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const AGENT_PACKAGE = "@agentclientprotocol/codex-acp@1.1.7";
const REQUEST_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 5_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function elicitationContent(params) {
  const schema = params?.requestedSchema;
  const properties = schema?.properties ?? {};
  const content = {};
  for (const key of schema?.required ?? Object.keys(properties)) {
    const property = properties[key] ?? {};
    const firstChoice = Array.isArray(property.oneOf) ? property.oneOf[0]?.const : undefined;
    content[key] = firstChoice ?? "SoloMap ACP validation answer";
  }
  return content;
}

class AcpProbe {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.waiters = new Set();
    this.permissionRequests = [];
    this.elicitationRequests = [];
    this.stderr = [];
  }

  async start() {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    this.child = spawn(npx, ["-y", AGENT_PACKAGE], {
      cwd: this.cwd,
      env: {
        ...process.env,
        CODEX_PATH: process.env.CODEX_PATH || "codex",
        INITIAL_AGENT_MODE: "read-only",
        NO_BROWSER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("error", (error) => this.failPending(error));
    this.child.once("exit", (code, signal) => {
      if (this.closing) return;
      this.failPending(new Error(`codex-acp exited unexpectedly (code=${code}, signal=${signal})`));
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.onMessage(JSON.parse(line));
      } catch (error) {
        this.failPending(new Error(`Invalid ACP JSON line: ${error.message}`));
      }
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderr.push(line.replace(/(Bearer\s+)[^\s"]+/gi, "$1[REDACTED]"));
      if (this.stderr.length > 30) this.stderr.shift();
    });

    return await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "solomap-acp-lifecycle-validator", version: "1" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
        elicitation: { form: {} },
      },
    });
  }

  onMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      void this.handleRequest(message);
      return;
    }

    if (message.method === "session/update") {
      const update = message.params?.update ?? {};
      this.updates.push({
        sessionId: message.params?.sessionId,
        type: update.sessionUpdate,
        toolCallId: update.toolCallId,
        toolKind: update.kind,
        toolStatus: update.status,
      });
      for (const waiter of this.waiters) waiter();
    }
  }

  async handleRequest(message) {
    try {
      if (message.method === "session/request_permission") {
        this.permissionRequests.push({
          sessionId: message.params?.sessionId,
          toolCallId: message.params?.toolCall?.toolCallId,
          kind: message.params?.toolCall?.kind,
        });
        const option = message.params?.options?.find((item) => item.kind === "allow_once");
        assert(option, "Permission request did not offer allow_once");
        this.respond(message.id, {
          outcome: { outcome: "selected", optionId: option.optionId },
        });
        return;
      }

      if (message.method === "elicitation/create") {
        this.elicitationRequests.push({
          sessionId: message.params?.sessionId,
          toolCallId: message.params?.toolCallId,
          mode: message.params?.mode,
        });
        this.respond(message.id, {
          action: "accept",
          content: elicitationContent(message.params),
        });
        return;
      }

      this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
    } catch (error) {
      this.respondError(message.id, -32603, error.message);
    }
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return withTimeout(response, timeoutMs, method);
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  write(message) {
    assert(this.child?.stdin?.writable, "codex-acp stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitForUpdate(predicate, timeoutMs = 30_000, fromIndex = 0) {
    const find = () => this.updates.slice(fromIndex).find(predicate);
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return withTimeout(new Promise((resolve) => {
      const check = () => {
        const match = find();
        if (!match) return;
        this.waiters.delete(check);
        resolve(match);
      };
      this.waiters.add(check);
    }), timeoutMs, "session/update");
  }

  failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (!this.child) return;
    this.closing = true;
    this.child.stdin.end();
    if (!(await waitForExit(this.child, EXIT_TIMEOUT_MS))) {
      this.child.kill("SIGTERM");
      await waitForExit(this.child, EXIT_TIMEOUT_MS);
    }
  }
}

async function prompt(probe, sessionId, text) {
  return await probe.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

async function run() {
  const workspace = await mkdtemp(join(tmpdir(), "solomap-acp-validation-"));
  const evidence = {
    adapter: AGENT_PACKAGE,
    sessionBoundBeforeFirstTurn: false,
    normalMultiTurn: false,
    waitingForPermission: false,
    waitingForUserInput: false,
    cancellation: false,
    resumeAcrossProcess: false,
  };
  let firstProbe;
  let resumedProbe;

  try {
    firstProbe = new AcpProbe(workspace);
    const initialized = await firstProbe.start();
    assert(initialized?.protocolVersion === 1, "ACP protocol version 1 was not negotiated");

    const created = await firstProbe.request("session/new", { cwd: workspace, mcpServers: [] });
    const sessionId = created?.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0, "session/new did not return a sessionId");
    evidence.sessionBoundBeforeFirstTurn = firstProbe.updates.length === 0;

    const firstUpdateCount = firstProbe.updates.length;
    const firstTurn = await prompt(firstProbe, sessionId, "Reply with exactly SOLOMAP_ACP_TURN_ONE and nothing else.");
    const firstTurnUpdates = firstProbe.updates.slice(firstUpdateCount);
    assert(firstTurn?.stopReason === "end_turn", `First turn stop reason was ${firstTurn?.stopReason}`);
    assert(firstTurnUpdates.some((item) => item.type === "agent_message_chunk"), "First turn had no agent message update");

    const secondUpdateCount = firstProbe.updates.length;
    const secondTurn = await prompt(firstProbe, sessionId, "Reply with exactly SOLOMAP_ACP_TURN_TWO and nothing else.");
    const secondTurnUpdates = firstProbe.updates.slice(secondUpdateCount);
    assert(secondTurn?.stopReason === "end_turn", `Second turn stop reason was ${secondTurn?.stopReason}`);
    assert(secondTurnUpdates.some((item) => item.type === "agent_message_chunk"), "Second turn had no agent message update");
    assert(secondTurnUpdates.every((item) => !item.sessionId || item.sessionId === sessionId), "Second turn changed session identity");
    evidence.normalMultiTurn = true;

    const permissionCount = firstProbe.permissionRequests.length;
    const approvalTurn = await prompt(
      firstProbe,
      sessionId,
      "Use the shell tool to run exactly `/usr/bin/printf SOLOMAP_ACP_APPROVAL`. Do not use any other tool."
    );
    assert(approvalTurn?.stopReason === "end_turn", `Approval turn stop reason was ${approvalTurn?.stopReason}`);
    assert(firstProbe.permissionRequests.length === permissionCount + 1, "Shell action did not produce exactly one permission request");
    assert(firstProbe.permissionRequests.at(-1)?.sessionId === sessionId, "Permission request lost session identity");
    evidence.waitingForPermission = true;

    const collaborationMode = created.configOptions?.find((option) => option.id === "collaboration_mode");
    assert(
      collaborationMode?.options?.some((option) => option.value === "plan"),
      "Agent did not advertise plan collaboration mode"
    );
    await firstProbe.request("session/set_config_option", {
      sessionId,
      configId: "collaboration_mode",
      value: "plan",
    });
    const elicitationCount = firstProbe.elicitationRequests.length;
    const inputTurn = await prompt(
      firstProbe,
      sessionId,
      "Use request_user_input exactly once. Ask one question with id choice and two options: Alpha and Beta. After the answer, reply with exactly INPUT_ACCEPTED."
    );
    assert(inputTurn?.stopReason === "end_turn", `Input turn stop reason was ${inputTurn?.stopReason}`);
    assert(firstProbe.elicitationRequests.length === elicitationCount + 1, "request_user_input did not produce exactly one elicitation request");
    assert(firstProbe.elicitationRequests.at(-1)?.sessionId === sessionId, "Elicitation request lost session identity");
    evidence.waitingForUserInput = true;
    await firstProbe.request("session/set_config_option", {
      sessionId,
      configId: "collaboration_mode",
      value: "default",
    });

    const cancelUpdateCount = firstProbe.updates.length;
    const cancelPrompt = prompt(
      firstProbe,
      sessionId,
      "Use the shell tool to run exactly `/bin/sh -c 'exec sleep 60'`. Do not use any other tool."
    );
    await firstProbe.waitForUpdate(
      (item) =>
        item.sessionId === sessionId &&
        (item.type === "tool_call" || item.type === "tool_call_update") &&
        item.toolStatus === "in_progress",
      30_000,
      cancelUpdateCount
    );
    firstProbe.notify("session/cancel", { sessionId });
    const cancelledTurn = await cancelPrompt;
    assert(cancelledTurn?.stopReason === "cancelled", `Cancelled turn stop reason was ${cancelledTurn?.stopReason}`);
    evidence.cancellation = true;

    await firstProbe.close();
    firstProbe = undefined;

    resumedProbe = new AcpProbe(workspace);
    const resumedInitialized = await resumedProbe.start();
    assert(resumedInitialized?.agentCapabilities?.loadSession === true, "Agent did not advertise loadSession support");
    await resumedProbe.request("session/load", { sessionId, cwd: workspace, mcpServers: [] });
    const resumedTurn = await prompt(resumedProbe, sessionId, "Reply with exactly SOLOMAP_ACP_RESUMED and nothing else.");
    assert(resumedTurn?.stopReason === "end_turn", `Resumed turn stop reason was ${resumedTurn?.stopReason}`);
    assert(resumedProbe.updates.some((item) => item.sessionId === sessionId && item.type === "agent_message_chunk"), "Resumed session had no agent message update");
    evidence.resumeAcrossProcess = true;

    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } catch (error) {
    const stderr = [...(firstProbe?.stderr ?? []), ...(resumedProbe?.stderr ?? [])];
    console.error(JSON.stringify({ ok: false, evidence, error: error.message, stderr }, null, 2));
    process.exitCode = 1;
  } finally {
    await resumedProbe?.close();
    await firstProbe?.close();
    try {
      await rmdir(workspace);
    } catch (error) {
      console.error(`Validation workspace retained at ${workspace}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

await run();
