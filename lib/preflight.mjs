/**
 * Preflight checks for a DSH plugin directory.
 *
 * Every check here exists because the awesome-list CI or the DSH client loader
 * fails on it, and each failure is silent or confusing at the point it happens:
 * a missing `dsh.bundle` is rejected by CI days later; a mismatched bundle id
 * makes the browser half never load, with no error anywhere.
 *
 * Nothing in this module touches the network.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Topic required by the awesome-list CI. */
export const REQUIRED_TOPIC = "dsh-plugin";

/** Top-level keys the catalog entry may carry. */
const CATALOG_KEYS = ["url", "name", "category", "description"];

/** Categories the catalog accepts today. */
export const CATEGORIES = [
	"agi", "ui", "usage", "theme", "model", "identity", "session", "memory",
	"tools", "wsl", "browser", "vision", "voice", "docs", "skill", "workflow",
	"git", "notify", "dev", "security", "remote", "market", "fun"
];

/** A file that looks like it holds a credential, so it must never be published. */
const SECRET_PATTERNS = [
	/^\.env(\..+)?$/,
	/\.pem$/,
	/\.key$/,
	/^id_rsa/,
	/^\.npmrc$/,
	/^\.netrc$/,
	/credentials/i,
	/secret/i
];

/**
 * Read and parse one JSON file.
 * @param path - absolute path.
 * @returns the parsed value, or `undefined` with a reason.
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
 * mismatch means the browser half is never activated.
 * @param source - the client bundle source.
 * @returns the id, or undefined.
 */
export function bundleIdOf(source) {
	return /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?\bid\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
}

/**
 * The row `name` inserted by a cordis patch file.
 * @param source - the patch YAML.
 * @returns the name, or undefined.
 */
export function patchNameOf(source) {
	return /-\s*insert:[\s\S]*?\bname\s*:\s*["']?([^\s"']+)["']?/.exec(source)?.[1];
}

/**
 * Validate a plugin directory.
 *
 * @param dir - the plugin root.
 * @param options - `owner`/`repo` to check identity against, when known.
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
	if (pkg.private === true) errors.push("package.json sets \"private\": true, which blocks npm publishing");
	if (typeof pkg.license !== "string") warnings.push("package.json has no license field");

	/* dsh.bundle is the requirement CI enforces; dsh.client alone is rejected. */
	const bundle = pkg.dsh?.bundle;
	if (bundle === void 0) {
		errors.push("package.json declares no dsh.bundle — the catalog CI rejects this (declaring only dsh.client is not installable)");
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

	/* --- the three identifiers must agree ------------------------------- */
	if (typeof pkg.name === "string" && facts.patch !== void 0) {
		const patchSource = readFileSync(join(dir, facts.patch.replace(/^\.\//, "")), "utf8");
		const rowName = patchNameOf(patchSource);
		facts.patchName = rowName;
		if (rowName !== void 0 && rowName !== pkg.name) {
			errors.push(`cordis patch inserts "${rowName}" but the package is named "${pkg.name}" — the module will not load`);
		}
	}

	if (facts.hasClient === true) {
		/* Find the client half: exports["./client"], dsh.client.entry, or lib/client.js. */
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
			warnings.push(`package.json repository does not point at ${expected}; npm will not link the package to the repo`);
		}
	}

	/* --- files that must never be published ------------------------------ */
	const risky = [];
	try {
		const scan = (d, rel) => {
			for (const name of readdirSync(d)) {
				if (name === "node_modules" || name === ".git") continue;
				const full = join(d, name);
				const r = rel === "" ? name : `${rel}/${name}`;
				if (statSync(full).isDirectory()) scan(full, r);
				else if (SECRET_PATTERNS.some((p) => p.test(name))) risky.push(r);
			}
		};
		scan(dir, "");
	} catch { /* a scan failure must not block the check */ }
	if (risky.length > 0) {
		warnings.push(`these files look like credentials and should not be published: ${risky.join(", ")}`);
	}

	/* --- tests ----------------------------------------------------------- */
	const testDir = join(dir, "test");
	facts.hasTests = existsSync(testDir);
	if (!facts.hasTests) warnings.push("no test/ directory — the catalog review reads the source, and tests help it pass");

	return { errors, warnings, facts };
}

/**
 * Render the awesome-list catalog entry for a published plugin.
 *
 * The quoting rule is not cosmetic: `description.en` containing ": " must be
 * quoted or YAML reads it as a nested mapping and the entry fails to parse.
 *
 * @param options - owner, repo, category, and the two descriptions.
 * @returns the YAML text.
 */
export function catalogEntry(options) {
	const { owner, repo, category, en, zh } = options;
	if (!CATEGORIES.includes(category)) {
		throw new Error(`category "${category}" is not one of: ${CATEGORIES.join(" ")}`);
	}
	const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
	const lines = [
		`url: https://github.com/${owner}/${repo}`,
		`name: ${owner}/${repo}`,
		`category: ${category}`,
		"description:",
		`  en: ${quote(en)}`
	];
	if (typeof zh === "string" && zh !== "") lines.push(`  zh: ${quote(zh)}`);
	return `${lines.join("\n")}\n`;
}

/**
 * Validate a catalog entry against the documented rules.
 * @param text - the YAML text.
 * @returns `{ errors, warnings }`.
 */
export function validateCatalogEntry(text) {
	const errors = [];
	const warnings = [];
	const topKeys = text.split("\n").filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(":")[0]);
	for (const key of topKeys) {
		if (!CATALOG_KEYS.includes(key)) errors.push(`"${key}" is not a documented top-level key`);
	}
	if (/^\s*npm:/m.test(text)) errors.push("a hand-written npm: key is rejected by CI — the mapping is collected from the registry");
	if (!/^url:\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/m.test(text)) errors.push("url must be an exact https://github.com/<owner>/<repo>");
	const enLine = text.split("\n").find((l) => l.trim().startsWith("en:"));
	if (enLine === void 0) errors.push("description.en is required");
	else {
		if (enLine.includes(": ") && !/^\s*en:\s*['"]/.test(enLine)) {
			errors.push("description.en contains \": \" and must be quoted, or YAML reads it as a nested key");
		}
		if (!/\.\s*['"]?\s*$/.test(enLine)) warnings.push("description.en should end with a period");
	}
	const cat = /^category:\s*(\S+)/m.exec(text)?.[1];
	if (cat !== void 0 && !CATEGORIES.includes(cat)) warnings.push(`category "${cat}" is not in the current list; a maintainer will re-file it`);
	return { errors, warnings };
}