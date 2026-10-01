/**
 * Contract test: check the plugin against the REAL interface declarations
 * extracted from the running harness, not against my assumptions.
 *
 * Reads the command service's own type surface and asserts that every field the
 * plugin touches exists, and that every field it must supply is supplied.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "C:/Users/gty/Documents/deepseek-harness/default-workspace/dsh-plugin-publish/lib/index.js";
const source = readFileSync(SRC, "utf8");

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/* --- The invocation contract, verbatim from the harness ------------------ */
/* CommandInvocation = { commandId, agent, rawInput, attachments, signal }
   Agent = { id: SessionId }
   CommandResult = { kind:'success', text? } | { kind:'error', text }        */

const fieldsRead = [...source.matchAll(/invocation\?\.(\w+)|invocation\.(\w+)/g)].map((m) => m[1] ?? m[2]);
console.log("invocation fields read:", [...new Set(fieldsRead)].join(", ") || "(none)");

check("reads rawInput (the real field name)", fieldsRead.includes("rawInput"));
check("does not read the nonexistent `input` field", !fieldsRead.includes("input"));
check("reads agent only to reach its id", !/invocation\??\.agent\??\.session/.test(source), "agent has no session property");

/* --- Agent is { id } only ------------------------------------------------ */
check("resolves the workspace through the sessions service", source.includes('ctx.get("sessions")'));
check("does not assume agent.session.header.cwd exists", !source.includes("agent?.session?.header"));

/* --- Config arrives as apply's second argument --------------------------- */
check("apply takes (ctx, config)", /function apply\(ctx, config\)/.test(source));
check("never reads ctx.config", !source.includes("ctx.config"));

/* --- Optional-service access is guarded ---------------------------------- */
check("guards ctx.get before calling it", source.includes('typeof ctx.get === "function"'));

/* --- Registration shape -------------------------------------------------- */
check("declares inject with commands", /const inject = \["commands"\]/.test(source));
check("passes name/description/input/handler", ["name:", "description:", "input:", "handler:"].every((k) => source.includes(k)));
check("input declares a hint", /input:\s*\{\s*hint:/.test(source));

/* --- Every result carries a kind and text -------------------------------- */
const results = [...source.matchAll(/kind:\s*"(success|error)"/g)].map((m) => m[1]);
check("returns only success/error kinds", results.every((k) => k === "success" || k === "error"), [...new Set(results)].join(","));
check("every error result carries text", !/kind:\s*"error"\s*\}/.test(source.replace(/\s+/g, " ")), "error without text");

/* --- The manifest must point the loader at the plugin entry -------------- */
const pkg = JSON.parse(readFileSync("C:/Users/gty/Documents/deepseek-harness/default-workspace/dsh-plugin-publish/package.json", "utf8"));
check("main points at the plugin entry", pkg.main === "./lib/index.js", pkg.main);
check("exports['.'] points at the plugin entry", pkg.exports["."] === "./lib/index.js", pkg.exports["."]);
check("the entry file exists", existsSync("C:/Users/gty/Documents/deepseek-harness/default-workspace/dsh-plugin-publish/lib/index.js"));

/* --- The installed copy must match the source ---------------------------- */
const INSTALLED = "C:/Users/gty/.dsh/profiles/desktop/node_modules/dsh-plugin-publish";
if (existsSync(INSTALLED)) {
	const installed = readFileSync(join(INSTALLED, "lib/index.js"), "utf8");
	check("the installed copy has the rawInput fix", installed.includes("invocation?.rawInput"));
	check("the installed copy resolves sessions", installed.includes('ctx.get("sessions")'));
	check("the installed copy guards ctx.get", installed.includes('typeof ctx.get === "function"'));
	const ipkg = JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8"));
	check("the installed manifest points at index.js", ipkg.exports["."] === "./lib/index.js", ipkg.exports["."]);
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);