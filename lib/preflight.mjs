/**
 * Preflight checks for a DSH plugin directory.
 *
 * Scope: **can another machine install this plugin from the repository we are
 * about to create?** Nothing here is about the plugin marketplace, and nothing
 * here touches the network.
 *
 * Every check exists because the DSH loader fails on it, and each failure is
 * silent or confusing at the point it happens:
 *
 *   - no `dsh.bundle`        -> `dsh plugin add` cannot install the package
 *   - a missing patch file   -> the bundle layer has nothing to apply
 *   - a mismatched row name  -> the module is never found
 *   - a mismatched bundle id -> the browser half never loads, with NO error
 *
 * The last two are the dangerous ones: the plugin looks installed and simply
 * does nothing.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Topic that marks a repository as a DSH plugin, for discovery on GitHub. */
export const REQUIRED_TOPIC = "dsh-plugin";

/** A file that looks like it holds a credential, so it must never be published. */
const SECRET_PATTERNS = [
	/^\.env(\..+)?$/,
	/\.pem$/,
	/\.key$/,
	/^id_rsa/,
	/^id_ed25519/,
	/^\.npmrc$/,
	/^\.netrc$/,
	/^\.github-token$/,
	/credentials/i,
	/secret/i
];

/**
 * Read and parse one JSON file.
 * @param path - absolute path.
 * @returns the parsed value, or an error reason.
 */
function readJson(path) {
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The bundle id inside a browser half, if it has one.
 *
 * The loader matches the registration id against the package name, so a
 * mismatch means the browser half is never activated — and nothing reports an
 * error. That silence is why this is checked.
 *
 * @param source - the client bundle source.
 * @returns the id, or undefined.
 */
export function bundleIdOf(source) {
	return /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,300}?\bid\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
}

/**
 * The `name` of the row a cordis patch inserts.
 *
 * Scoped to the insert list so an unrelated top-level `name:` cannot match.
 * @param source - the patch YAML.
 * @returns the name, or undefined.
 */
export function patchNameOf(source) {
	const insert = /-\s*insert:([\s\S]*)/.exec(source)?.[1] ?? source;
	return /\bname\s*:\s*["']?([^\s"']+)["']?/.exec(insert)?.[1];
}

/**
 * Validate one plugin directory.
 *
 * @param dir - the plugin root.
 * @param options - `owner`/`repo`, to check the manifest's own repository link.
 * @returns `{ errors, warnings, facts }`; errors block publishing.
 */
export function preflight(dir, options = {}) {
	const errors = [];
	const warnings = [];
	const facts = {};

	/* --- manifest ------------------------------------------------------- */
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) {
		return { errors: ["package.json is missing"], warnings, facts };
	}
	const parsed = readJson(pkgPath);
	if (parsed.error !== void 0) {
		return { errors: [`package.json is not valid JSON: ${parsed.error}`], warnings, facts };
	}
	const pkg = parsed.value;
	facts.name = pkg.name;
	facts.version = pkg.version;

	if (typeof pkg.name !== "string" || pkg.name === "") errors.push("package.json has no name");
	if (pkg.private === true) errors.push("package.json sets \"private\": true");
	if (typeof pkg.license !== "string") warnings.push("package.json has no license field");
	if (typeof pkg.description !== "string" || pkg.description === "") {
		warnings.push("package.json has no description; the repository will have none either");
	}

	/* --- installability: dsh.bundle is what `dsh plugin add` needs ------- */
	const bundle = pkg.dsh?.bundle;
	if (bundle === void 0) {
		errors.push("package.json declares no dsh.bundle — `dsh plugin add` cannot install this package (declaring only dsh.client is not installable)");
	} else if (typeof bundle.patch !== "string" || bundle.patch === "") {
		errors.push("dsh.bundle.patch must name the patch file");
	} else {
		const patchPath = join(dir, bundle.patch.replace(/^\.\//, ""));
		if (!existsSync(patchPath)) {
			errors.push(`dsh.bundle.patch points at ${bundle.patch}, which does not exist`);
		} else {
			facts.patch = bundle.patch;
		}
	}
	facts.hasClient = pkg.dsh?.client !== void 0;

	/* --- the identifiers the loader matches ----------------------------- */
	if (typeof pkg.name === "string" && facts.patch !== void 0) {
		const patchSource = readFileSync(join(dir, facts.patch.replace(/^\.\//, "")), "utf8");
		const rowName = patchNameOf(patchSource);
		facts.patchName = rowName;
		if (rowName !== void 0 && rowName !== pkg.name) {
			errors.push(`the cordis patch inserts "${rowName}" but the package is named "${pkg.name}" — the module will never load`);
		}
	}

	if (facts.hasClient === true) {
		const candidates = [
			pkg.exports?.["./client"],
			pkg.dsh?.client?.entry,
			"./lib/client.js"
		].filter((c) => typeof c === "string");
		let clientPath;
		for (const c of candidates) {
			const p = join(dir, c.replace(/^\.\//, ""));
			if (existsSync(p)) { clientPath = p; break; }
		}
		if (clientPath === void 0) {
			errors.push("dsh.client is declared but no client bundle was found (looked at exports[\"./client\"], dsh.client.entry, lib/client.js)");
		} else {
			const source = readFileSync(clientPath, "utf8");
			const id = bundleIdOf(source);
			facts.bundleId = id;
			if (id === void 0) {
				errors.push(`${clientPath} has no __ModuleLoader__.load({ id }) registration`);
			} else if (id !== pkg.name) {
				errors.push(`the client bundle registers id "${id}" but the package is named "${pkg.name}" — the browser half will never load`);
			}
		}
	}

	/* --- repository identity -------------------------------------------- */
	if (options.owner !== void 0 && options.repo !== void 0) {
		const expected = `${options.owner}/${options.repo}`;
		const url = pkg.repository?.url ?? "";
		if (!url.includes(expected)) {
			warnings.push(`package.json repository does not point at ${expected} — a stale link on the repository page`);
		}
	}

	/* --- files that must never be published ------------------------------ */
	const risky = [];
	try {
		const scan = (d, rel, depth) => {
			if (depth > 4) return;
			for (const name of readdirSync(d)) {
				if (name === "node_modules" || name === ".git") continue;
				const full = join(d, name);
				const r = rel === "" ? name : `${rel}/${name}`;
				if (statSync(full).isDirectory()) scan(full, r, depth + 1);
				else if (SECRET_PATTERNS.some((p) => p.test(name))) risky.push(r);
			}
		};
		scan(dir, "", 1);
	} catch { /* a scan failure must not block the check */ }
	if (risky.length > 0) {
		warnings.push(`these files look like credentials and would be published publicly: ${risky.join(", ")}`);
	}

	return { errors, warnings, facts };
}

/**
 * The two install commands a published plugin supports.
 *
 * Both are printed after a publish, because the whole point of uploading is that
 * another machine can install the result — and which command works depends on
 * whether that machine has git:
 *
 *   - `dsh plugin add github:owner/repo` resolves through git, so it needs git
 *     installed.
 *   - the codeload tarball URL is fetched over HTTPS, so it works without git.
 *
 * A commit-pinned URL is offered as well, because it cannot drift: `HEAD` follows
 * whatever is pushed next, while a pinned commit installs exactly what was
 * published.
 *
 * @param options - `owner`, `repo`, and optionally `commit`.
 * @returns `{ withGit, withoutGit, pinned }`.
 */
export function installCommands(options) {
	const { owner, repo, commit } = options;
	return {
		withGit: `dsh plugin --profile desktop add github:${owner}/${repo}`,
		withoutGit: `dsh plugin --profile desktop add https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`,
		pinned: typeof commit === "string" && commit !== ""
			? `dsh plugin --profile desktop add https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`
			: void 0
	};
}