/**
 * Preflight and install-command tests.
 *
 * These are hermetic: every case builds a throwaway plugin directory, so the
 * checks that guard a real publish are exercised without touching the network.
 *
 * The scope is installability — can another machine `dsh plugin add` this? — not
 * the plugin marketplace, which this tool no longer concerns itself with.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight, installCommands, bundleIdOf, patchNameOf } from "../lib/preflight.mjs";

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
	/* A missing test directory is no longer reported: it was a marketplace-review
	   hint, and the scope is now installability only. */
	check("preflight no longer reports a marketplace-only fact", r.facts.hasTests === void 0);
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
	check("a mismatched patch row name is rejected", r.errors.some((e) => e.includes("never load")), JSON.stringify(r.errors));
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

/* --- install commands -------------------------------------------------- */
/*
 * These are the whole point of publishing: another machine must be able to
 * install the result. Which command works depends on whether that machine has
 * git, so both are always produced.
 */
{
	const commands = installCommands({ owner: "Gty2408", repo: "dsh-demo" });
	check("the git form names owner/repo", commands.withGit === "dsh plugin --profile desktop add github:Gty2408/dsh-demo", commands.withGit);
	check("the no-git form uses codeload", commands.withoutGit.includes("codeload.github.com/Gty2408/dsh-demo/tar.gz/HEAD"), commands.withoutGit);
	check("no pinned form without a commit", commands.pinned === void 0);
}
{
	const commands = installCommands({ owner: "a", repo: "b", commit: "0123456789abcdef0123456789abcdef01234567" });
	check("a pinned form appears with a commit", typeof commands.pinned === "string", String(commands.pinned));
	check("the pinned form carries the commit", commands.pinned.includes("0123456789abcdef0123456789abcdef01234567"));
	check("the pinned form does not use HEAD", !commands.pinned.includes("/HEAD"));
}
{
	/* An empty commit must not produce a broken URL ending in a slash. */
	const commands = installCommands({ owner: "a", repo: "b", commit: "" });
	check("an empty commit produces no pinned form", commands.pinned === void 0);
}
{
	const commands = installCommands({ owner: "a", repo: "b" });
	check("both commands target the same repo", commands.withGit.includes("a/b") && commands.withoutGit.includes("a/b"));
	check("neither command leaks a token", !commands.withGit.includes("gh") && !commands.withoutGit.includes("ghp"));
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