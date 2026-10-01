/**
 * End-to-end proof: drive the PLUGIN's own handler (not the CLI) with a real
 * upload, using the saved token.
 *
 * Creates a throwaway plugin and publishes it through the same code path a
 * `/publish-plugin --push` invocation takes, then verifies the repo over the API.
 *
 * The repo name is FIXED and reused rather than timestamped, and the test never
 * deletes it: the `repo` scope cannot delete repositories (that needs
 * `delete_repo`), so a test that created a fresh repo each run would litter the
 * account with undeletable ones. Reusing one name keeps the footprint at exactly
 * one repo, and every run overwrites it.
 *
 * Skipped unless a token is present, so the hermetic suite still passes without
 * credentials.
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOKEN = (() => {
	try { return readFileSync("C:/Users/gty/.dsh/.github-token", "utf8").trim(); } catch { return void 0; }
})();
if (TOKEN === void 0 || TOKEN === "") {
	console.log("SKIP no token at ~/.dsh/.github-token; the live push test needs one");
	process.exit(0);
}

const plugin = await import("../lib/index.js");

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/* A throwaway plugin that passes preflight. */
const dir = join(tmpdir(), `dsh-e2e-publish-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "lib"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });

/* One fixed repo name, reused every run. */
const REPO = "dsh-publish-e2e-probe";
const PKG = "dsh-e2e-demo";

writeFileSync(join(dir, "package.json"), JSON.stringify({
	name: PKG,
	version: "1.0.0",
	license: "MIT",
	description: "An end-to-end publish probe.",
	dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } }
}, null, 2));
writeFileSync(join(dir, "cordis.patch.yml"), `- insert:\n    - id: ${PKG}\n      name: ${PKG}\n`);
writeFileSync(join(dir, "lib/client.js"), `window.__ModuleLoader__.load({ id: "${PKG}", factory: () => {} });\n`);
writeFileSync(join(dir, "test/x.test.mjs"), "// probe\n");

/* Drive the plugin handler exactly as the command registry does. */
let registered;
plugin.apply({ commands: { register: (d) => { registered = d; } }, config: { token: TOKEN, owner: "Gty2408", branch: "main" } });

const out = await registered.handler({ input: `${dir} --push --repo ${REPO} --category dev` });
console.log("\n--- handler output ---");
console.log(out.text);
console.log("---\n");

check("handler reported success", out.kind === "success", out.kind);
check("handler named the published url", out.text.includes(`Gty2408/${REPO}`));

/* Verify over the API. */
const headers = { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "user-agent": "e2e", "x-github-api-version": "2022-11-28" };
const repoRes = await fetch(`https://api.github.com/repos/Gty2408/${REPO}`, { headers });
check("the repo exists on GitHub", repoRes.status === 200, String(repoRes.status));

if (repoRes.ok) {
	const repo = await repoRes.json();
	check("repo is public", repo.private === false);
	check("topic was set", (repo.topics ?? []).includes("dsh-plugin"), JSON.stringify(repo.topics));

	const tree = await (await fetch(`https://api.github.com/repos/Gty2408/${REPO}/git/trees/main?recursive=1`, { headers })).json();
	const paths = (tree.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path);
	console.log("uploaded files:", paths.join(", "));
	check("all plugin files landed", ["package.json", "cordis.patch.yml", "lib/client.js", "test/x.test.mjs"].every((p) => paths.includes(p)), JSON.stringify(paths));

	const pkgRaw = await (await fetch(`https://api.github.com/repos/Gty2408/${REPO}/contents/package.json`, { headers })).json();
	const uploaded = JSON.parse(Buffer.from(pkgRaw.content, "base64").toString("utf8"));
	check("the manifest survived the round trip", uploaded.name === PKG && uploaded.dsh?.bundle?.patch === "./cordis.patch.yml");
}

/* The catalog entry the handler wrote. */
const entryPath = join(dir, "..", `Gty2408__${REPO}.yml`);
let entryText;
try { entryText = readFileSync(entryPath, "utf8"); } catch { entryText = void 0; }
check("a catalog entry was written", typeof entryText === "string", entryPath);
if (entryText !== void 0) {
	check("entry names the repo", entryText.includes(`url: https://github.com/Gty2408/${REPO}`));
	check("entry quotes the description", /^\s*en: '/m.test(entryText));
}

rmSync(dir, { recursive: true, force: true });
try { rmSync(entryPath, { force: true }); } catch { /* ignore */ }
console.log(`\nNOTE: ${REPO} is intentionally left in place (the repo scope cannot delete it).`);
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);