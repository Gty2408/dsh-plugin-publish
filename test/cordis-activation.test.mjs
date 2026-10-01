/**
 * Prove the installed plugin activates under a faithful Cordis-like context.
 *
 * If this passes against the INSTALLED copy, then the running app's failure is
 * purely its cached module, not the code.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "C:/Users/gty/.dsh/profiles/desktop/node_modules/dsh-plugin-publish";
const mod = await import(`file:///${DIR}/lib/index.js`);

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

check("the installed copy exports apply", typeof mod.apply === "function");
check("the installed copy exports inject", Array.isArray(mod.inject), JSON.stringify(mod.inject));
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
const rawCtx = { commands: { register: (d) => { registered = d; return () => {}; } } };
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
		const out = await registered.handler({ input: DIR });
		check("handler works with an empty config", out?.kind === "success", `${out?.kind} ${String(out?.text).slice(0, 60)}`);
	} catch (error) {
		check("handler works with an empty config", false, error.message);
	}
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);