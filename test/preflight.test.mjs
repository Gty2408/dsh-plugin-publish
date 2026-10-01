/**
 * Preflight and catalog-entry tests.
 *
 * These are hermetic: every case builds a throwaway plugin directory, so the
 * checks that guard a real publish are exercised without touching the network.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight, catalogEntry, validateCatalogEntry, bundleIdOf, patchNameOf } from "../lib/preflight.mjs";

const failures = [];
const check = (label, ok, detail = "") => {
	if (!ok) failures.push(label);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
};

const base = join(tmpdir(), `dsh-publish-test-${process.pid}`);
rmSync(base, { recursive: true, force: true });

/**
 * Build a plugin directory.
 * @param label - subdirectory name.
 * @param files - relative path -> content.
 * @returns the directory.
 */
function make(label, files) {
	const dir = join(base, label);
	mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

/** A minimal valid plugin. */
const VALID = {
	"package.json": JSON.stringify({
		name: "dsh-demo",
		version: "1.0.0",
		license: "MIT",
		description: "A demo plugin.",
		dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } }
	}, null, 2),
	"cordis.patch.yml": "- insert:\n    - id: dsh-demo\n      name: dsh-demo\n",
	"lib/client.js": 'window.__ModuleLoader__.load({\n\tid: "dsh-demo",\n\tfactory: () => {}\n});\n',
	"test/x.test.mjs": "// test\n"
};

/* --- extractors ------------------------------------------------------- */
check("bundleIdOf reads the loader id", bundleIdOf(VALID["lib/client.js"]) === "dsh-demo");
check("bundleIdOf tolerates whitespace", bundleIdOf('window.__ModuleLoader__ . load ( {\n  id : "x-y" }') === "x-y");
check("bundleIdOf returns undefined when absent", bundleIdOf("no loader here") === void 0);
check("patchNameOf reads the inserted name", patchNameOf(VALID["cordis.patch.yml"]) === "dsh-demo");

/* --- the happy path --------------------------------------------------- */
{
	const dir = make("valid", VALID);
	const r = preflight(dir);
	check("valid plugin has no errors", r.errors.length === 0, JSON.stringify(r.errors));
	check("valid plugin reports its name", r.facts.name === "dsh-demo");
	check("valid plugin finds the bundle id", r.facts.bundleId === "dsh-demo");
	check("valid plugin sees tests", r.facts.hasTests === true);
}

/* --- dsh.bundle is the requirement CI enforces ------------------------ */
{
	const dir = make("no-bundle", {
		...VALID,
		"package.json": JSON.stringify({
			name: "dsh-demo",
			license: "MIT",
			dsh: { client: { platform: "web" } }
		})
	});
	const r = preflight(dir);
	check("declaring only dsh.client is rejected", r.errors.some((e) => e.includes("dsh.bundle")), JSON.stringify(r.errors));
}

/* --- the three identifiers must agree --------------------------------- */
{
	const dir = make("id-mismatch", {
		...VALID,
		"lib/client.js": 'window.__ModuleLoader__.load({ id: "wrong-name", factory: () => {} });\n'
	});
	const r = preflight(dir);
	check("a mismatched bundle id is rejected", r.errors.some((e) => e.includes("browser half")), JSON.stringify(r.errors));
}
{
	const dir = make("patch-mismatch", {
		...VALID,
		"cordis.patch.yml": "- insert:\n    - id: x\n      name: other-name\n"
	});
	const r = preflight(dir);
	check("a mismatched patch row name is rejected", r.errors.some((e) => e.includes("will not load")), JSON.stringify(r.errors));
}

/* --- other blockers --------------------------------------------------- */
{
	const dir = make("private", {
		...VALID,
		"package.json": JSON.stringify({ name: "dsh-demo", license: "MIT", private: true, dsh: { bundle: { patch: "./cordis.patch.yml" } } })
	});
	check("private:true is rejected", preflight(dir).errors.some((e) => e.includes("private")));
}
{
	const dir = make("bad-patch-path", {
		...VALID,
		"package.json": JSON.stringify({ name: "dsh-demo", license: "MIT", dsh: { bundle: { patch: "./nope.yml" } } })
	});
	check("a missing patch file is rejected", preflight(dir).errors.some((e) => e.includes("does not exist")));
}
{
	const dir = make("bad-json", { "package.json": "{ not json" });
	check("invalid JSON is reported", preflight(dir).errors.some((e) => e.includes("not valid JSON")));
}
{
	const dir = make("empty", {});
	check("a missing manifest is reported", preflight(dir).errors.some((e) => e.includes("missing")));
}

/* --- credential-shaped files warn ------------------------------------- */
{
	const dir = make("secrets", { ...VALID, ".env": "TOKEN=x", "server.pem": "key" });
	const r = preflight(dir);
	check("credential-shaped files warn", r.warnings.some((w) => w.includes(".env")), JSON.stringify(r.warnings));
	check("a credential warning does not block", r.errors.length === 0);
}

/* --- catalog entry ---------------------------------------------------- */
{
	const entry = catalogEntry({
		owner: "Gty2408",
		repo: "dsh-demo",
		category: "session",
		en: "Delete a session: it does things.",
		zh: "删除会话。"
	});
	check("entry url is exact", entry.includes("url: https://github.com/Gty2408/dsh-demo"));
	check("entry name is owner/repo", entry.includes("name: Gty2408/dsh-demo"));
	check("entry quotes an en description containing ': '", /^\s*en: '/m.test(entry), entry.split("\n")[4]);
	check("entry validates clean", validateCatalogEntry(entry).errors.length === 0, JSON.stringify(validateCatalogEntry(entry).errors));
}
{
	check("an unquoted ': ' description is rejected", (() => {
		const bad = "url: https://github.com/a/b\nname: a/b\ncategory: session\ndescription:\n  en: Vision toolkit: OCR and more.\n";
		return validateCatalogEntry(bad).errors.some((e) => e.includes("must be quoted"));
	})());
}
{
	check("a hand-written npm: key is rejected", (() => {
		const bad = "url: https://github.com/a/b\nname: a/b\ncategory: session\nnpm: a\n";
		return validateCatalogEntry(bad).errors.some((e) => e.includes("npm:"));
	})());
}
{
	check("an unknown top-level key is rejected", (() => {
		const bad = "url: https://github.com/a/b\nname: a/b\ncategory: session\nstars: 5\n";
		return validateCatalogEntry(bad).errors.some((e) => e.includes("stars"));
	})());
}
{
	check("an invalid category throws when generating", (() => {
		try { catalogEntry({ owner: "a", repo: "b", category: "nope", en: "x." }); return false; }
		catch { return true; }
	})());
}
{
	check("a non-github url is rejected", (() => {
		const bad = "url: https://gitlab.com/a/b\nname: a/b\ncategory: session\n";
		return validateCatalogEntry(bad).errors.some((e) => e.includes("url must be"));
	})());
}

/* --- the plugin half's contract --------------------------------------- */
{
	const plugin = await import("../lib/index.js");
	check("plugin exports apply", typeof plugin.apply === "function");
	check("plugin exports inject", Array.isArray(plugin.inject) && plugin.inject.includes("commands"));
	check("plugin name is a valid cordis identity", /^[a-z][a-z0-9_-]*$/.test(plugin.name), plugin.name);

	/* Drive apply with a stub registry and check the command contract. */
	let registered;
	const ctx = { commands: { register: (d) => { registered = d; return () => {}; } } };
	plugin.apply(ctx);
	check("command name matches the registry pattern", /^[a-z][a-z0-9_-]*$/.test(registered?.name ?? ""), registered?.name);
	check("command has a non-empty description", typeof registered?.description === "string" && registered.description.trim() !== "");
	check("command has a handler", typeof registered?.handler === "function");

	const dir = make("plugin-half", VALID);
	const out = await registered.handler({ rawInput: dir });
	check("handler returns a CommandResult", out?.kind === "success", JSON.stringify(out)?.slice(0, 80));
	check("handler reports readiness", out.text.includes("Ready to publish"), out.text.split("\n").slice(-3).join(" | "));
	check("handler shows the push form", out.text.includes("--push"));

	const badDir = make("plugin-half-bad", { "package.json": JSON.stringify({ name: "x", dsh: { client: {} } }) });
	const badOut = await registered.handler({ rawInput: badDir });
	check("handler reports blockers", badOut.text.includes("Blocked"), badOut.text.split("\n").slice(0, 6).join(" | "));
	check("blockers are an error result", badOut.kind === "error", badOut.kind);

	const missing = await registered.handler({ rawInput: join(base, "does-not-exist") });
	check("handler handles a missing directory", missing.kind === "error" && missing.text.includes("No package.json"));

	/* --- input grammar ------------------------------------------------- */
	{
		const d = make("grammar", VALID);
		check("--repo is parsed", (await registered.handler({ rawInput: `${d} --repo custom-name` })).text.includes("Ready to publish"));
		check("an unknown option is rejected", (await registered.handler({ rawInput: `${d} --nope` })).kind === "error");
		check("a missing option value is rejected", (await registered.handler({ rawInput: `${d} --repo` })).kind === "error");
		check("extra positional arguments are rejected", (await registered.handler({ rawInput: `${d} extra` })).kind === "error");
	}

	/* --- push requires a token, and never touches the network without one -- */
	{
		const d = make("push-no-token", VALID);
		/* Point the home lookup at an empty directory so no real token is found. */
		const savedHome = process.env.USERPROFILE;
		process.env.USERPROFILE = join(base, "empty-home");
		mkdirSync(process.env.USERPROFILE, { recursive: true });
		const pushed = await registered.handler({ rawInput: `${d} --push` });
		process.env.USERPROFILE = savedHome;
		check("--push without a token is refused", pushed.kind === "error", pushed.kind);
		check("the refusal explains where to put a token", pushed.text.includes(".github-token") && pushed.text.includes("repo"), pushed.text.split("\n").slice(0, 4).join(" | "));
		check("the refusal links the token page", pushed.text.includes("github.com/settings/tokens"));
	}

	/* --- a broken plugin is refused even with --push -------------------- */
	{
		const d = make("push-broken", { "package.json": JSON.stringify({ name: "x", dsh: { client: {} } }) });
		const r = await registered.handler({ rawInput: `${d} --push` });
		check("a broken plugin never reaches the network", r.kind === "error" && r.text.includes("Blocked"), r.kind);
	}
}

rmSync(base, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);