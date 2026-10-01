/**
 * Prove the suite is hermetic: no test may reach a real GitHub account.
 *
 * This exists because an earlier version published to a real repository on every
 * run. The `repo` scope cannot delete repositories, so each run left an artifact
 * the user had to remove by hand — the account accumulated them. A test that
 * writes to a real account is a side effect with assertions attached, not a test.
 *
 * The check looks for what a live call actually NEEDS — a token read from disk,
 * or a fetch against a real host — rather than for strings like an owner name
 * that legitimately appear as sample data in a generated document.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** A test is live only if it both reads a credential and calls out. */
const READS_TOKEN = /readFileSync\([^)]*github-token/;
const CALLS_OUT = /\bfetch\(\s*[`"']https:\/\/(?!example\.)/;
/** An unmocked fetch against the API, which the fakes replace before use. */
const RAW_API_CALL = /\bfetch\(\s*`?\$\{?API\}?|\bfetch\(\s*[`"']https:\/\/api\.github\.com/;

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

const files = readdirSync(here).filter((n) => n.endsWith(".test.mjs")).sort();

for (const file of files) {
	const source = readFileSync(join(here, file), "utf8");

	/* A live test reads the real token file. */
	const readsToken = READS_TOKEN.test(source);
	check(`${file} does not read a real token`, !readsToken, readsToken ? "reads ~/.dsh/.github-token" : "");

	/* A live test fetches a real host outside a replaced global fetch. The fakes
	   in push.test.mjs swap globalThis.fetch, so an api.github.com literal there
	   is a URL string handed to the fake, not a call. Distinguish by whether the
	   file installs a fake. */
	const installsFake = source.includes("globalThis.fetch =");
	if (!installsFake) {
		const raw = RAW_API_CALL.test(source);
		check(`${file} does not call the API directly`, !raw, raw ? "unmocked api.github.com call" : "");
	}
}

/* The runner must not pick up the opt-in live script. */
const runner = readFileSync(join(here, "run.mjs"), "utf8");
check("the runner selects only *.test.mjs", runner.includes('.endsWith(".test.mjs")'));
check("live-verify.mjs is not a .test.mjs file", !readdirSync(here).includes("live-verify.test.mjs"));

/* The live script must refuse to run without its confirmation flag. */
const live = readFileSync(join(here, "live-verify.mjs"), "utf8");
check("the live script requires an explicit flag", live.includes("--i-know-this-creates-a-repo"));
check("the live script reuses one repo name", /const REPO = "dsh-plugin-publish-live-verify"/.test(live));
check("the live script prints a cleanup url", live.includes("/settings"));

/* --- no token-shaped literal anywhere in the package ---------------------- */
/*
 * GitHub's secret scanning rejects a push whose content contains a token-shaped
 * string, and it is right to: a real token in a public repository is compromised
 * the moment it lands. An earlier version of secrets.test.mjs pasted a live token
 * in as a fixture and the push failed with "Secret detected in content".
 *
 * So this scans every shipped file. A test that needs a token-shaped input must
 * build it at runtime from inert fragments.
 */
const TOKEN_LITERAL = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})/;
const ROOT = join(here, "..");
const shipped = [];
const collect = (dir, rel) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) collect(join(dir, entry.name), r);
		else if (/\.(mjs|js|json|md|yml)$/.test(entry.name)) shipped.push(r);
	}
};
collect(ROOT, "");

const tainted = shipped.filter((rel) => TOKEN_LITERAL.test(readFileSync(join(ROOT, rel), "utf8")));
check("no shipped file contains a token-shaped literal", tainted.length === 0, tainted.join(", "));

console.log(failures.length === 0 ? "\nALL PASS — the suite cannot touch a real account" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);