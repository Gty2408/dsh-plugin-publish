/**
 * The DSH plugin half of `dsh-plugin-publish`.
 *
 * Registers one slash command, `/publish-plugin`, which runs the same preflight
 * the CLI runs and reports the result inside the harness. The upload itself is
 * deliberately NOT reachable from a command: it needs a device-flow
 * authorization the user performs in a browser, and a slash command has no way
 * to show that code or wait on it. The command therefore validates and prints
 * the exact CLI line to run.
 *
 * Only Node builtins are imported, so the profile's module bootstrap is not a
 * dependency of this package.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preflight, catalogEntry, validateCatalogEntry } from "./preflight.mjs";

/** Cordis plugin identity. */
const name = "plugin-publish";
/** The command registry owns slash commands. */
const inject = ["commands"];

/**
 * Locate the plugin root to validate: an explicit path, else the session's cwd.
 * @param invocation - the command invocation.
 * @returns an absolute directory path.
 */
function targetDir(invocation) {
	const raw = typeof invocation?.input === "string" ? invocation.input.trim() : "";
	if (raw !== "") return resolve(raw);
	const cwd = invocation?.agent?.session?.header?.cwd ?? invocation?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/**
 * Render the preflight outcome as command text.
 * @param dir - the plugin root.
 * @returns the report text.
 */
function report(dir) {
	const { errors, warnings, facts } = preflight(dir);
	const lines = [
		`Plugin publish check — ${dir}`,
		"",
		`  package    : ${facts.name ?? "(not found)"}`,
		`  version    : ${facts.version ?? "-"}`,
		`  bundle id  : ${facts.bundleId ?? "(none)"}`,
		`  patch row  : ${facts.patchName ?? "(none)"}`,
		`  dsh.bundle : ${facts.patch ?? "(missing)"}`,
		`  tests      : ${facts.hasTests === true ? "present" : "none"}`,
		""
	];

	if (errors.length === 0) {
		lines.push("Ready to publish.");
	} else {
		lines.push("Blocked:");
		for (const error of errors) lines.push(`  - ${error}`);
	}
	for (const warning of warnings) lines.push(`  ! ${warning}`);

	/* Show the catalog entry that would be submitted, since its quoting rule is
	   the easiest thing to get wrong by hand. */
	if (errors.length === 0 && typeof facts.name === "string") {
		let description;
		try { description = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description; } catch { description = void 0; }
		if (typeof description === "string" && description !== "") {
			const entry = catalogEntry({ owner: "<owner>", repo: facts.name, category: "session", en: description });
			const check = validateCatalogEntry(entry);
			lines.push("", "Catalog entry for the plugin market:", "", ...entry.split("\n").map((l) => `  ${l}`));
			for (const error of check.errors) lines.push(`  ! ${error}`);
		}
	}

	lines.push("", errors.length === 0
		? `To publish:  npx dsh-plugin-publish "${dir}"`
		: "Fix the errors above, then re-run /publish-plugin.");
	return lines.join("\n");
}

/**
 * Register the command.
 * @param ctx - Host context carrying the command registry.
 */
function apply(ctx) {
	ctx.commands.register({
		name: "publish-plugin",
		description: "Check whether the plugin in this workspace is ready to publish to GitHub, and print the command that does it.",
		input: { hint: "[directory]" },
		handler: (invocation) => {
			const dir = targetDir(invocation);
			if (!existsSync(join(dir, "package.json"))) {
				return { kind: "success", text: `No package.json in ${dir}. Pass a plugin directory: /publish-plugin <dir>` };
			}
			return { kind: "success", text: report(dir) };
		}
	});
}

export { apply, inject, name };