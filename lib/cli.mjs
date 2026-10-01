#!/usr/bin/env node
/**
 * `dsh-plugin-publish` — publish a DSH plugin to GitHub in one command.
 *
 * The order matters: everything is validated locally before the network is
 * touched, so a broken manifest never creates a half-published repository.
 *
 * The result is a public repository another machine can install the plugin from,
 * with `dsh plugin add`. The two install commands are printed at the end.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { preflight, installCommands, REQUIRED_TOPIC } from "./preflight.mjs";
import { deviceAuth, GitHub, stashToken, dropToken } from "./github.mjs";

const HELP = `dsh-plugin-publish — publish a DSH plugin to GitHub

Usage
  dsh-plugin-publish [directory] [options]

Options
  --description <text>  Repository description (default: the manifest's)
  --repo <name>         Repository name (default: the package name)
  --owner <login>       GitHub account (default: the authenticated user)
  --token <token>       Use an existing token instead of the device flow
  --branch <name>       Branch to publish to (default: main)
  --message <text>      Commit message
  --force               Overwrite the branch when it already has commits
  --dry-run             Validate and print the plan; touch nothing
  --yes                 Skip the confirmation prompt
  --help                Show this text

Exit codes
  0 success   1 usage error   2 preflight failed   3 network/auth failure
`;

/** Parse argv into a position directory plus flags. */
function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--help" || a === "-h") { flags.help = true; continue; }
		if (a === "--dry-run") { flags.dryRun = true; continue; }
		if (a === "--force") { flags.force = true; continue; }
		if (a === "--yes" || a === "-y") { flags.yes = true; continue; }
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === void 0 || next.startsWith("--")) { flags[key] = true; continue; }
			flags[key] = next;
			i += 1;
			continue;
		}
		positional.push(a);
	}
	return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
if (flags.help === true) { process.stdout.write(HELP); process.exit(0); }

const dir = resolve(positional[0] ?? ".");
if (!existsSync(dir)) {
	process.stderr.write(`error: ${dir} does not exist\n`);
	process.exit(1);
}

/* --- 1. local validation, before any network use ---------------------- */
const packageName = (() => {
	try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name; } catch { return void 0; }
})();
const repo = typeof flags.repo === "string" ? flags.repo : packageName;

const result = preflight(dir, {});
process.stdout.write(`\nValidating ${basename(dir)}\n`);
process.stdout.write(`  package   : ${result.facts.name ?? "(unknown)"}\n`);
process.stdout.write(`  bundle id : ${result.facts.bundleId ?? "(none)"}\n`);
process.stdout.write(`  patch row : ${result.facts.patchName ?? "(none)"}\n`);
process.stdout.write(`  tests     : ${result.facts.hasTests === true ? "present" : "none"}\n`);

for (const warning of result.warnings) process.stdout.write(`  warn  ${warning}\n`);
if (result.errors.length > 0) {
	process.stderr.write("\nPreflight failed:\n");
	for (const error of result.errors) process.stderr.write(`  error ${error}\n`);
	process.stderr.write("\nNothing was uploaded.\n");
	process.exit(2);
}
process.stdout.write("  preflight : ok\n");

/* The repository description comes from the manifest unless overridden. */
const description = typeof flags.description === "string"
	? flags.description
	: (() => {
		try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description; } catch { return void 0; }
	})();
if (typeof description !== "string" || description === "") {
	process.stderr.write("\nerror: no description. Pass --description \"...\" or set one in package.json.\n");
	process.exit(1);
}

if (flags.dryRun === true) {
	const owner = flags.owner ?? "<you>";
	const commands = installCommands({ owner, repo });
	process.stdout.write(`\nDry run. Would publish to github.com/${owner}/${repo}\n`);
	process.stdout.write(`Topics: ${REQUIRED_TOPIC}, dsh, deepseek-harness, cordis\n`);
	process.stdout.write(`\nOther machines would install it with:\n`);
	process.stdout.write(`  ${commands.withGit}          (needs git)\n`);
	process.stdout.write(`  ${commands.withoutGit}          (no git needed)\n`);
	process.exit(0);
}

/* --- 2. authenticate -------------------------------------------------- */
let token = typeof flags.token === "string" ? flags.token : void 0;
let stashed;
if (token === void 0) {
	process.stdout.write("\nRequesting a device code...\n");
	token = await deviceAuth({
		scope: "repo",
		onCode: ({ userCode, verificationUri }) => {
			process.stdout.write(`\n  Open ${verificationUri}\n  Enter code: ${userCode}\n\n  Waiting for authorization`);
		}
	}).catch((error) => {
		/* github.com is intermittently unreachable on some networks even when
		   api.github.com is fine. The device flow needs github.com, so report
		   the diagnosis and name the fallback rather than dumping a stack. */
		process.stderr.write(`\ndevice authorization did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
		process.stderr.write("  github.com must be reachable for the device flow.\n");
		process.stderr.write("  If it is not, api.github.com may still work — pass --token <token> instead.\n");
		process.exit(3);
	});
	process.stdout.write(" authorized\n");
}
stashed = token === flags.token ? void 0 : stashToken(token);

try {
	const gh = new GitHub(token);
	const login = await gh.whoami();
	const owner = typeof flags.owner === "string" ? flags.owner : login;
	process.stdout.write(`\nAuthenticated as ${login}\n`);

	/* --- 3. confirm ---------------------------------------------------- */
	if (flags.yes !== true) {
		process.stdout.write(`\nAbout to publish ${result.facts.name} to github.com/${owner}/${repo}\n`);
		process.stdout.write("Re-run with --yes to proceed.\n");
		process.exit(0);
	}

	/* --- 4. repo, tree, topics ----------------------------------------- */
	const made = await gh.ensureRepo(owner, repo, description);
	process.stdout.write(`  repo   : ${made.created ? "created" : "exists"} ${made.url}\n`);

	const pushed = await gh.pushTree(owner, repo, dir, {
		branch: flags.branch ?? "main",
		message: flags.message ?? `chore: publish ${result.facts.name}@${result.facts.version ?? "0.0.0"}`,
		force: flags.force === true,
		onProgress: (rel) => process.stdout.write(`  upload : ${rel}\n`)
	});
	process.stdout.write(`  commit : ${pushed.commit.slice(0, 8)} (${pushed.files} files)\n`);

	const topics = await gh.setTopics(owner, repo, [REQUIRED_TOPIC, "dsh", "deepseek-harness", "cordis"]);
	process.stdout.write(`  topics : ${topics.join(", ")}\n`);

	/* --- 5. how another machine installs it ---------------------------- */
	const commands = installCommands({ owner, repo, commit: pushed.commit });
	process.stdout.write(`\nPublished: ${made.url}\n`);
	process.stdout.write(`\nInstall it on another machine with:\n`);
	process.stdout.write(`  ${commands.withGit}\n`);
	process.stdout.write(`      (resolves through git; that machine needs git installed)\n\n`);
	process.stdout.write(`  ${commands.withoutGit}\n`);
	process.stdout.write(`      (fetched over HTTPS; no git needed)\n`);
	if (commands.pinned !== void 0) {
		process.stdout.write(`\nTo pin exactly this commit instead of following HEAD:\n`);
		process.stdout.write(`  ${commands.pinned}\n`);
	}
	process.stdout.write("\nRevoke access when you are done: https://github.com/settings/applications\n");
} catch (error) {
	process.stderr.write(`\nfailed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(3);
} finally {
	if (stashed !== void 0) dropToken(stashed);
}