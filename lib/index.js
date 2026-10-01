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
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { preflight, installCommands } from "./preflight.mjs";
import { GitHub } from "./github.mjs";

/** Cordis plugin identity. */
const name = "plugin-publish";
/**
 * The command registry owns slash commands.
 *
 * `sessions` is deliberately NOT declared here: it is read through `ctx.get()`
 * inside the handler, which is the documented optional-access form and the same
 * pattern the session-delete plugin uses. Declaring it would make the whole
 * plugin fail to activate on a profile that composes no session store, for a
 * feature — resolving the default directory — that is merely a convenience.
 */
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
 * Locate the plugin root to validate.
 *
 * The invocation carries only `agent: { id }` — `CommandInvocation.agent` is a
 * bare session id, with no session object behind it — so the workspace path has
 * to be resolved through the `sessions` service by that id. Falling back to
 * `process.cwd()` is the last resort, not the second choice: the harness process
 * runs from the install directory, which is never the user's workspace.
 *
 * @param invocation - the command invocation.
 * @param sessions - the sessions service, when available.
 * @returns an absolute directory path.
 */
function targetDir(invocation, sessions) {
	const raw = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
	if (raw !== "") return resolve(raw);

	const id = invocation?.agent?.id;
	if (typeof id === "string" && id !== "" && sessions !== void 0) {
		try {
			const session = sessions.get(id);
			const cwd = session?.header?.cwd;
			if (typeof cwd === "string" && cwd !== "") return cwd;
		} catch { /* fall through to the process directory */ }
	}
	return process.cwd();
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

	lines.push("", errors.length === 0
		? `To publish:  /publish-plugin ${dir} --push`
		: "Fix the errors above, then re-run /publish-plugin.");
	return lines.join("\n");
}

/**
 * Parse the command input into a directory and flags.
 *
 * The grammar is deliberately tiny: `<directory>` plus `--push`, `--repo <name>`,
 * `--description <text>`. Anything unrecognized is reported rather than ignored,
 * so a typo cannot silently publish to the wrong place.
 *
 * @param raw - the raw command input.
 * @returns `{ dir, push, repo, description, error }`.
 */
function parseInput(raw) {
	const tokens = String(raw ?? "").trim().split(/\s+/).filter((t) => t !== "");
	const out = { dir: void 0, push: false, repo: void 0, description: void 0, error: void 0 };
	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i];
		if (t === "--push") { out.push = true; continue; }
		if (t === "--repo" || t === "--description") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) { out.error = `${t} needs a value`; return out; }
			if (t === "--repo") out.repo = value; else out.description = value;
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
 * `config` arrives as the second `apply` argument — Cordis passes the validated
 * Config, and reading it off `ctx` would need it declared as an injectable
 * service instead.
 *
 * @param ctx - Host context carrying the command registry.
 * @param config - validated {@link Config}.
 */
function apply(ctx, config) {
	const settings = config ?? {};
	/* Optional access: absent on a profile with no session store, in which case
	   only the no-argument default is unavailable. Guarded because a context
	   without `get` (a minimal profile, or a test harness) must not break the
	   command entirely. */
	const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;

	ctx.commands.register({
		name: "publish-plugin",
		description: "Validate the plugin in this workspace and, with --push, publish it to GitHub.",
		input: { hint: "[directory] [--push] [--repo name] [--description text]" },
		handler: async (invocation) => {
			const parsed = parseInput(invocation?.rawInput);
			if (parsed.error !== void 0) return { kind: "error", text: `/publish-plugin: ${parsed.error}` };

			const dir = parsed.dir === void 0 ? targetDir(invocation, sessions) : resolve(parsed.dir);
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

			/* The repository description comes from the manifest unless the
			   caller overrode it. */
			let description = typeof parsed.description === "string" && parsed.description !== "" ? parsed.description : void 0;
			if (description === void 0) {
				try { description = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description; } catch { description = void 0; }
			}
			if (typeof description !== "string" || description === "") {
				return { kind: "error", text: "package.json has no description. Pass one with --description." };
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

				/* The point of publishing is that another machine can install the
				   result, so the commands are printed rather than left to be looked up. */
				const commands = installCommands({ owner, repo, commit: pushed.commit });
				log.push("", `Published: ${made.url}`, "", "Install it on another machine with:");
				log.push(`  ${commands.withGit}`);
				log.push("      (resolves through git; that machine needs git installed)");
				log.push("");
				log.push(`  ${commands.withoutGit}`);
				log.push("      (fetched over HTTPS; no git needed)");
				if (commands.pinned !== void 0) {
					log.push("", "To pin exactly this commit instead of following HEAD:");
					log.push(`  ${commands.pinned}`);
				}
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