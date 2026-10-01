/**
 * Prove the plugin activates under a faithful Cordis-like context.
 *
 * The context below throws on any property that is not declared in `inject`,
 * exactly as Cordis does. That is what catches the two mistakes this plugin
 * actually shipped with: reading `ctx.config` (needs an inject declaration, and
 * Cordis passes config as `apply`'s second argument instead), and reading
 * `invocation.input` (the field is `rawInput`, and the wrong name fails
 * silently by making every argument look absent).
 *
 * Runs against this repository's own copy, so it works on any machine.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..");
const mod = await import(new URL("../lib/index.js", import.meta.url).href);

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

check("the package exports apply", typeof mod.apply === "function");
check("the package exports inject", Array.isArray(mod.inject), JSON.stringify(mod.inject));
check("inject declares commands", mod.inject.includes("commands"));
check("apply declares exactly two parameters", mod.apply.length === 2, String(mod.apply.length));

/* A context that throws on undeclared property access, like Cordis does. */
const declared = new Set(mod.inject);
const guard = (obj) => new Proxy(obj, {
	get(target, prop) {
		if (typeof prop === "string" && !declared.has(prop) && !(prop in target) && prop !== "then") {
			throw new Error(`cannot get property "${prop}" without inject`);
		}
		return target[prop];
	}
});

let registered;
const rawCtx = {
	commands: { register: (d) => { registered = d; return () => {}; } },
	/* Optional-service access, the documented form: returns undefined rather
	   than throwing when the profile composes no such service. */
	get: (key) => (key === "sessions" ? { get: () => void 0 } : void 0)
};
try {
	mod.apply(guard(rawCtx), {});
	check("apply runs against a strict context", true);
} catch (error) {
	check("apply runs against a strict context", false, error.message);
}

check("a command was registered", registered !== void 0);
check("the command is publish-plugin", registered?.name === "publish-plugin", registered?.name);

/* The handler must work with no config at all (the common case). */
if (registered !== void 0) {
	try {
		const out = await registered.handler({ rawInput: DIR });
		check("handler works with an empty config", out?.kind === "success", `${out?.kind} ${String(out?.text).slice(0, 60)}`);
	} catch (error) {
		check("handler works with an empty config", false, error.message);
	}

	/* Pin the invocation field name. `CommandInvocation` calls it `rawInput`;
	   reading `input` instead yields undefined for every argument, which reads
	   as "no argument given" rather than an error — it fails silently. So the
	   decisive check is that a BAD path given as an argument is rejected: if
	   the argument were ignored, the handler would fall back to the session cwd
	   and succeed. */
	{
		const bogus = await registered.handler({ rawInput: "Z:/definitely/not/here" });
		check("an argument is read from rawInput, not ignored", bogus.kind === "error" && bogus.text.includes("No package.json"), bogus.kind);

		const unknown = await registered.handler({ rawInput: `${DIR} --bogus` });
		check("an unknown option surfaces as an error", unknown.kind === "error", unknown.text.split("\n")[0]);
	}

	/* The no-argument form must resolve the workspace through the sessions
	   service. `CommandInvocation.agent` is a bare `{ id }`, so reading
	   `agent.session.header.cwd` finds nothing and silently falls back to the
	   harness process directory — which is never the user's workspace. */
	{
		let resolved;
		const ctx = {
			commands: { register: (d) => { resolved = d; return () => {}; } },
			get: (key) => (key === "sessions"
				? { get: (id) => (id === "sess-1" ? { header: { cwd: DIR } } : void 0) }
				: void 0)
		};
		mod.apply(ctx, {});
		const out = await resolved.handler({ rawInput: "", agent: { id: "sess-1" } });
		check("the no-argument form resolves the session workspace", out.kind === "success", `${out.kind} ${String(out.text).split("\n")[0]}`);
	}

	/* With no session store, only the default is lost; an explicit directory
	   must still work, so the plugin stays useful on a minimal profile. */
	{
		let resolved;
		mod.apply({ commands: { register: (d) => { resolved = d; return () => {}; } }, get: () => void 0 }, {});
		const out = await resolved.handler({ rawInput: DIR, agent: { id: "sess-1" } });
		check("an explicit directory works without a session store", out.kind === "success", out.kind);
	}
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);