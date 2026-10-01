#!/usr/bin/env node
/**
 * `dsh-plugin-publish` — publish a DSH plugin to GitHub in one command.
 *
 * The order matters: everything is validated locally before the network is
 * touched, so a broken manifest never creates a half-published repository.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { preflight, catalogEntry, validateCatalogEntry, REQUIRED_TOPIC } from "./preflight.mjs";
import { deviceAuth, GitHub, stashToken, dropToken } from "./github.mjs";

const HELP = `dsh-plugin-publish — publish a DSH plugin to GitHub

Usage
  dsh-plugin-publish [directory] [options]

Options
  --category <name>   Catalog category for the awesome-list entry (default: session)
  --description <en>  English one-line description for the catalog entry
  --description-zh <> Chinese one-line description
  --repo <name>       Repository name (default: the package name)
  --owner <login>     GitHub account (default: the authenticated user)
  --token <token>     Use an existing token instead of the device flow
  --branch <name>     Branch to publish to (default: main)
  --message <text>    Commit message
  --force             Overwrite the branch when it already has commits
  --dry-run           Validate and print the plan; touch nothing
  --yes               Skip the confirmation prompt
  --help              Show this text

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

/* The catalog entry is generated now so its own rules are checked too. */
const category = typeof flags.category === "string" ? flags.category : "session";
const en = typeof flags.description === "string"
	? flags.description
	: (() => {
		try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).description; } catch { return void 0; }
	})();
if (typeof en !== "string" || en === "") {
	process.stderr.write("\nerror: no English description. Pass --description \"...\" or set one in package.json.\n");
	process.exit(1);
}
const entryText = catalogEntry({ owner: flags.owner ?? "<owner>", repo, category, en, zh: flags.descriptionZh });
const entryCheck = validateCatalogEntry(entryText);
if (entryCheck.errors.length > 0) {
	process.stderr.write("\nCatalog entry would be invalid:\n");
	for (const error of entryCheck.errors) process.stderr.write(`  error ${error}\n`);
	process.exit(2);
}
for (const warning of entryCheck.warnings) process.stdout.write(`  warn  ${warning}\n`);

if (flags.dryRun === true) {
	process.stdout.write(`\nDry run. Would publish to github.com/${flags.owner ?? "<you>"}/${repo}\n`);
	process.stdout.write(`Topics: ${REQUIRED_TOPIC}, dsh, deepseek-harness, cordis\n`);
	process.stdout.write(`\nCatalog entry:\n${entryText}`);
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
	const made = await gh.ensureRepo(owner, repo, en);
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

	/* --- 5. catalog entry for the PR ----------------------------------- */
	const finalEntry = catalogEntry({ owner, repo, category, en, zh: flags.descriptionZh });
	const entryPath = join(dir, "..", `${owner}__${repo}.yml`);
	writeFileSync(entryPath, finalEntry);

	process.stdout.write(`\nPublished: ${made.url}\n`);
	process.stdout.write(`\nCatalog entry written to ${entryPath}\n`);
	process.stdout.write("Submit it as a PR to github.com/awesome-dsh-plugin/awesome-dsh-plugin:\n");
	process.stdout.write(`  add the file at data/plugins/${owner}__${repo}.yml\n`);
	process.stdout.write("\nThe repo must be at least 1 day old before that PR passes CI.\n");
	process.stdout.write("\nRevoke access when you are done: https://github.com/settings/applications\n");
} catch (error) {
	process.stderr.write(`\nfailed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(3);
} finally {
	if (stashed !== void 0) dropToken(stashed);
}