/**
 * The DSH plugin half of `dsh-plugin-publish`.
 *
 * Registers one slash command, `/publish-plugin`, which validates a plugin and
 * — with `--push` — publishes it to GitHub through the same code the CLI uses.
 *
 * The token is read from the plugin config or `~/.dsh/.github-token`. No
 * interactive authorization is needed on this path, which is what makes the
 * upload reachable from a command at all.
 *
 * Only Node builtins are imported, so the profile's module bootstrap is not a
 * dependency of this package.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { preflight, catalogEntry, validateCatalogEntry } from "./preflight.mjs";
import { GitHub } from "./github.mjs";

/** Cordis plugin identity. */
const name = "plugin-publish";
/** The command registry owns slash commands. */
const inject = ["commands"];

/**
 * Where the token is looked for, in order.
 *
 * `dsh-plugin-publish`'s config wins, so a user can keep several accounts; the
 * home file is the convenient default the CLI writes.
 * @param config - the plugin config, when the profile supplies one.
 * @returns the token, or undefined.
 */
function findToken(config) {
	if (typeof config?.token === "string" && config.token !== "") return config.token;
	const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
	const path = join(home, ".dsh", ".github-token");
	try {
		const value = readFileSync(path, "utf8").trim();
		return value === "" ? void 0 : value;
	} catch {
		return void 0;
	}
}

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
		`Plugin publish check 鈥?${dir}`,
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
		? `To publish:  /publish-plugin ${dir} --push`
		: "Fix the errors above, then re-run /publish-plugin.");
	return lines.join("\n");
}

/**
 * Parse the command input into a directory and flags.
 *
 * The grammar is deliberately tiny: `<directory>` plus `--push`, `--repo <name>`,
 * `--category <name>`. Anything unrecognized is reported rather than ignored, so
 * a typo cannot silently publish to the wrong place.
 *
 * @param raw - the raw command input.
 * @returns `{ dir, push, repo, category, error }`.
 */
function parseInput(raw) {
	const tokens = String(raw ?? "").trim().split(/\s+/).filter((t) => t !== "");
	const out = { dir: void 0, push: false, repo: void 0, category: void 0, error: void 0 };
	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i];
		if (t === "--push") { out.push = true; continue; }
		if (t === "--repo" || t === "--category") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) { out.error = `${t} needs a value`; return out; }
			if (t === "--repo") out.repo = value; else out.category = value;
			i += 1;
			continue;
		}
		if (t.startsWith("--")) { out.error = `unknown option "${t}"`; return out; }
		if (out.dir === void 0) { out.dir = t; continue; }
		out.error = `unexpected extra argument "${t}"`;
		return out;
	}
	return out;
}

/**
 * Register the commands.
 *
 * `config` arrives as the second `apply` argument 鈥?Cordis passes the validated
 * Config, and reading it off `ctx` would need it declared as an injectable
 * service instead.
 *
 * @param ctx - Host context carrying the command registry.
 * @param config - validated {@link Config}.
 */
function apply(ctx, config) {
	const settings = config ?? {};

	ctx.commands.register({
		name: "publish-plugin",
		description: "Validate the plugin in this workspace and, with --push, publish it to GitHub.",
		input: { hint: "[directory] [--push] [--repo name] [--category name]" },
		handler: async (invocation) => {
			const parsed = parseInput(invocation?.input);
			if (parsed.error !== void 0) return { kind: "error", text: `/publish-plugin: ${parsed.error}` };

			const dir = parsed.dir === void 0 ? targetDir(invocation) : resolve(parsed.dir);
			if (!existsSync(join(dir, "package.json"))) {
				return { kind: "error", text: `No package.json in ${dir}. Pass a plugin directory: /publish-plugin <dir>` };
			}

			/* Validation always runs, and always runs first: a broken manifest must
			   never reach the network. */
			const { errors, facts } = preflight(dir);
			if (errors.length > 0) return { kind: "error", text: report(dir) };

			if (parsed.push !== true) return { kind: "success", text: report(dir) };

			const token = findToken(config);
			if (token === void 0) {
				return {
					kind: "error",
					text: [
						"No GitHub token found.",
						"",
						"Put one at ~/.dsh/.github-token (a classic token with the `repo` scope),",
						"or set `token` in this plugin's settings.",
						"",
						"Create one at https://github.com/settings/tokens/new"
					].join("\n")
				};
			}

			const gh = new GitHub(token);
			const owner = typeof settings.owner === "string" && settings.owner !== "" ? settings.owner : await gh.whoami();
			const repo = parsed.repo ?? facts.name;
			const category = parsed.category ?? "dev";

			/* The catalog entry needs an English description; fall back to the
			   manifest's, which preflight already required to be present. */
			let description;
			try { description = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description; } catch { description = void 0; }
			if (typeof description !== "string" || description === "") {
				return { kind: "error", text: "package.json has no description, which the catalog entry requires." };
			}

			const log = [`Publishing ${facts.name} to github.com/${owner}/${repo}`, ""];
			try {
				const made = await gh.ensureRepo(owner, repo, description);
				log.push(`  repo   : ${made.created ? "created" : "exists"} ${made.url}`);

				const pushed = await gh.pushTree(owner, repo, dir, {
					branch: settings.branch ?? "main",
					message: `chore: publish ${facts.name}@${facts.version ?? "0.0.0"}`,
					force: settings.force === true
				});
				log.push(`  commit : ${pushed.commit.slice(0, 8)} (${pushed.files} files)`);

				const topics = await gh.setTopics(owner, repo, ["dsh-plugin", "dsh", "deepseek-harness", "cordis"]);
				log.push(`  topics : ${topics.join(", ")}`);

				const entry = catalogEntry({ owner, repo, category, en: description });
				const entryPath = join(dir, "..", `${owner}__${repo}.yml`);
				writeFileSync(entryPath, entry);
				log.push("", `Published: ${made.url}`, "", `Catalog entry: ${entryPath}`);
				log.push(`Submit it to github.com/awesome-dsh-plugin/awesome-dsh-plugin at data/plugins/${owner}__${repo}.yml`);
				log.push("", "The repo must be at least 1 day old before that PR passes CI.");
				return { kind: "success", text: log.join("\n") };
			} catch (error) {
				/* Report the partial progress: a failure halfway through leaves a repo
				   behind, and the user needs to know that. */
				log.push("", `Failed: ${error instanceof Error ? error.message : String(error)}`);
				return { kind: "error", text: log.join("\n") };
			}
		}
	});
}

export { apply, inject, name };