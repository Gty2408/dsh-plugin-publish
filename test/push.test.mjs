/**
 * End-to-end proof of the push path, WITHOUT creating a repository.
 *
 * ## Why this test no longer touches GitHub
 *
 * An earlier version published to a real repository to prove the flow worked.
 * That was wrong for three reasons:
 *
 *   1. The `repo` scope cannot delete repositories — that needs `delete_repo` —
 *      so every run left an artifact the user had to remove by hand.
 *   2. A test that writes to a real account is not a test; it is a side effect
 *      with assertions attached.
 *   3. It made `npm test` require network access and a credential, so the suite
 *      could not run offline.
 *
 * The push path is instead proven against a **fake GitHub** that speaks the same
 * REST surface: it records the requests and returns realistic payloads. Every
 * branch of `pushTree` — the empty-repo seed, the blob/tree/commit/ref sequence,
 * the 409 case, error propagation — is exercised, with no account involved.
 *
 * The real network path is verified once, deliberately, by `live-verify.mjs`,
 * which is NOT part of the suite and refuses to run without an explicit flag.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const { GitHub, resilientFetch, listFilesRespectingGitignore, globToRegExp, parseGitignore } = await import("../lib/github.mjs");

const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/**
 * A GitHub stand-in that records calls and answers like the real API.
 *
 * The responses below are copied from real ones observed against the live API,
 * including the two shapes that cost the most time to discover: a brand-new
 * repository reporting its missing branch as 409, and `POST /user/repos`
 * returning 201 with the repository object.
 */
function fakeGitHub(options = {}) {
	const calls = [];
	const state = {
		repoExists: options.repoExists ?? false,
		branchStatus: options.branchStatus ?? 404,
		blobFailAt: options.blobFailAt ?? -1,
		/* What the repository already has, so the merge can be observed. */
		topics: options.existingTopics ?? [],
		/* The description already on the repository, for the update path. */
		description: options.description ?? null
	};
	let blobCount = 0;

	const handler = async (url, init = {}) => {
		const path = String(url).replace("https://api.github.com", "");
		const method = init.method ?? "GET";
		const body = init.body === void 0 ? void 0 : JSON.parse(init.body);
		calls.push({ method, path, body });

		const json = (status, payload) => new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" }
		});

		if (method === "GET" && path === "/user") return json(200, { login: "probe-user" });

		if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
			return state.repoExists
				? json(200, { html_url: `https://github.com${path}`, description: state.description })
				: json(404, { message: "Not Found" });
		}

		if (method === "PATCH" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
			state.description = body.description;
			return json(200, { html_url: `https://github.com${path}`, description: state.description });
		}

		if (method === "POST" && path === "/user/repos") {
			state.repoExists = true;
			return json(201, { html_url: `https://github.com/probe-user/${body.name}` });
		}

		if (method === "GET" && /\/git\/ref\/heads\//.test(path)) {
			return state.branchStatus === 200
				? json(200, { object: { sha: "parent-sha" } })
				: json(state.branchStatus, { message: "Git Repository is empty." });
		}

		if (method === "PUT" && /\/contents\//.test(path)) {
			/* Seeding an empty repo creates the default branch. */
			state.branchStatus = 200;
			return json(201, { content: { sha: "seed-sha" } });
		}

		if (method === "POST" && path.endsWith("/git/blobs")) {
			blobCount += 1;
			if (blobCount === state.blobFailAt) return json(422, { message: "Blob rejected" });
			return json(201, { sha: `blob-${blobCount}` });
		}

		if (method === "POST" && path.endsWith("/git/trees")) return json(201, { sha: "tree-sha" });
		if (method === "POST" && path.endsWith("/git/commits")) return json(201, { sha: "commit-sha" });
		if (method === "PATCH" && /\/git\/refs\/heads\//.test(path)) return json(200, { object: { sha: body.sha } });
		/* The topics endpoint answers a GET with the current list, and a PUT
		   replaces it — which is exactly why the merge has to be tested. */
		if (method === "GET" && path.endsWith("/topics")) return json(200, { names: state.topics });
		if (method === "PUT" && path.endsWith("/topics")) { state.topics = body.names; return json(200, { names: state.topics }); }

		return json(404, { message: `unhandled ${method} ${path}` });
	};

	return { calls, handler };
}

/* --- a plugin directory to upload ---------------------------------------- */
const dir = join(tmpdir(), `dsh-fake-push-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "lib"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }, null, 2));
writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: probe\n      name: probe\n");
writeFileSync(join(dir, "lib/index.js"), "export const name = 'probe';\n");

/** Run a body with `fetch` replaced, restoring it afterwards. */
async function withFake(fake, body) {
	const original = globalThis.fetch;
	globalThis.fetch = (url, init) => fake.handler(url, init);
	try {
		return await body();
	} finally {
		globalThis.fetch = original;
	}
}

/* --- 1. a brand-new repo: seed, then upload ------------------------------ */
{
	const fake = fakeGitHub({ repoExists: false, branchStatus: 409 });
	const gh = new GitHub("fake-token");
	const result = await withFake(fake, async () => {
		const made = await gh.ensureRepo("probe-user", "probe-repo", "A probe.");
		const pushed = await gh.pushTree("probe-user", "probe-repo", dir, { message: "test" });
		return { made, pushed };
	});

	check("the repo is reported as created", result.made.created === true, result.made.url);
	check("a 409 empty-repo is seeded, not treated as an error", fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")), JSON.stringify(fake.calls.map((c) => `${c.method} ${c.path}`).slice(0, 4)));
	check("every file became a blob", result.pushed.files === 3, String(result.pushed.files));
	check("a commit was created", result.pushed.commit === "commit-sha", result.pushed.commit);
	check("the branch was updated", fake.calls.some((c) => c.method === "PATCH" && c.path.includes("/git/refs/heads/main")));
	check("no request was made outside api.github.com", fake.calls.every((c) => c.path.startsWith("/")), "");
}

/* --- 2. an existing repo: no seed, no create ----------------------------- */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 200 });
	const gh = new GitHub("fake-token");
	const result = await withFake(fake, async () => {
		const made = await gh.ensureRepo("probe-user", "probe-repo", "A probe.");
		const pushed = await gh.pushTree("probe-user", "probe-repo", dir, {});
		return { made, pushed };
	});

	check("an existing repo is not recreated", result.made.created === false);
	check("no repository was created", !fake.calls.some((c) => c.method === "POST" && c.path === "/user/repos"));
	check("an existing branch is not seeded", !fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")));
}

/* --- 3. a 404 branch also seeds ------------------------------------------ */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 404 });
	const gh = new GitHub("fake-token");
	await withFake(fake, () => gh.pushTree("probe-user", "probe-repo", dir, {}));
	check("a 404 branch is seeded too", fake.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")));
}

/* --- 4. a blob failure propagates with its path -------------------------- */
{
	const fake = fakeGitHub({ repoExists: true, branchStatus: 200, blobFailAt: 2 });
	const gh = new GitHub("fake-token");
	let error;
	try {
		await withFake(fake, () => gh.pushTree("probe-user", "probe-repo", dir, {}));
	} catch (e) { error = e; }
	check("a blob failure throws", error !== void 0, error?.message ?? "no error");
	/* The message must name the file that failed, so a partial upload is
	   diagnosable. Which file lands second is not guaranteed, so assert the
	   message names *a* file rather than one specific name. */
	check("the failure names the file", /could not upload \S+\.(js|json|yml)/.test(String(error?.message ?? "")), String(error?.message).slice(0, 80));
	check("no commit was attempted after the failure", !fake.calls.some((c) => c.path.endsWith("/git/commits")));
}

/* --- 5. topics ----------------------------------------------------------- */
{
	const fake = fakeGitHub();
	const gh = new GitHub("fake-token");
	const names = await withFake(fake, () => gh.setTopics("probe-user", "probe-repo", ["dsh-plugin"]));
	check("topics are sent", names.includes("dsh-plugin"), JSON.stringify(names));
	check("the topic request targets the topics endpoint", fake.calls.some((c) => c.path.endsWith("/topics")));
}

/* --- 5b. topics are MERGED, not replaced --------------------------------- */
/*
 * The topics endpoint replaces the whole list, so a blind PUT silently drops
 * whatever the user set by hand. This pins the read-then-merge behaviour.
 */
{
	const fake = fakeGitHub({ existingTopics: ["my-own-topic", "dsh-plugin"] });
	const gh = new GitHub("fake-token");
	const names = await withFake(fake, () => gh.setTopics("probe-user", "probe-repo", ["dsh-plugin", "dsh", "cordis"]));

	check("an existing topic survives the write", names.includes("my-own-topic"), JSON.stringify(names));
	check("the required topics are present", ["dsh-plugin", "dsh", "cordis"].every((t) => names.includes(t)), JSON.stringify(names));
	check("no topic is duplicated", names.length === new Set(names).size, JSON.stringify(names));
	const readIndex = fake.calls.findIndex((c) => c.method === "GET" && c.path.endsWith("/topics"));
	const writeIndex = fake.calls.findIndex((c) => c.method === "PUT" && c.path.endsWith("/topics"));
	check("the current topics are read before writing", readIndex !== -1 && readIndex < writeIndex, `read@${readIndex} write@${writeIndex}`);
}

/* --- 5c. `.gitignore` is honoured on upload ------------------------------ */
/*
 * Without this, a build directory or an editor's state is pushed to a public
 * repository just because it sits next to the source.
 */
{
	const gi = join(tmpdir(), `dsh-gitignore-${process.pid}`);
	rmSync(gi, { recursive: true, force: true });
	for (const d of ["lib", "dist", "node_modules", "keep", "deep/nested"]) mkdirSync(join(gi, d), { recursive: true });
	writeFileSync(join(gi, "package.json"), "{}");
	writeFileSync(join(gi, "lib/index.js"), "x");
	writeFileSync(join(gi, "keep/kept.js"), "x");
	writeFileSync(join(gi, "dist/bundle.js"), "build output");
	writeFileSync(join(gi, "node_modules/dep.js"), "dependency");
	writeFileSync(join(gi, "debug.log"), "log");
	writeFileSync(join(gi, "important.log"), "log");
	writeFileSync(join(gi, "deep/nested/skip.js"), "x");
	writeFileSync(join(gi, ".gitignore"), "dist/\n*.log\n!important.log\n");
	/* A nested ignore file, to prove the walk accumulates rules per directory. */
	writeFileSync(join(gi, "deep/.gitignore"), "nested/\n");

	const rel = listFilesRespectingGitignore(gi).map((f) => relative(gi, f).split(sep).join("/")).sort();
	const has = (p) => rel.includes(p);
	check("an ignored directory is excluded", !has("dist/bundle.js"), JSON.stringify(rel));
	check("node_modules is excluded", !has("node_modules/dep.js"), JSON.stringify(rel));
	check("an ignored extension is excluded", !has("debug.log"), JSON.stringify(rel));
	check("a negated pattern is re-included", has("important.log"), JSON.stringify(rel));
	check("a nested .gitignore applies", !has("deep/nested/skip.js"), JSON.stringify(rel));
	check("ordinary sources are kept", has("lib/index.js") && has("keep/kept.js"), JSON.stringify(rel));

	/* The unit-level pieces, so a glob regression is diagnosable. */
	check("`**/x` matches at any depth", globToRegExp("**/x").test("a/b/x") && globToRegExp("**/x").test("x"));
	check("`*` does not cross a slash", !globToRegExp("**/*.log").test("a/b.log") === false && !globToRegExp("a/*.log").test("a/b/c.log"));
	check("a directory-only rule spares a file of the same name", parseGitignore("build/")[0].dirOnly === true);
	check("a comment is not a rule", parseGitignore("# note\nx").length === 1);
	rmSync(gi, { recursive: true, force: true });
}

/* --- 5d. an oversized file is refused, naming the file ------------------- */
/*
 * The blobs endpoint takes the content inline. Without this check GitHub
 * rejects the request and the message does not say which file was too big.
 */
{
	const big = join(tmpdir(), `dsh-bigfile-${process.pid}`);
	rmSync(big, { recursive: true, force: true });
	mkdirSync(big, { recursive: true });
	writeFileSync(join(big, "package.json"), "{}");
	writeFileSync(join(big, "huge.bin"), Buffer.alloc(41 * 1024 * 1024));

	const fake = fakeGitHub({ repoExists: true, branchStatus: 200 });
	const gh = new GitHub("fake-token");
	let error;
	try {
		await withFake(fake, () => gh.pushTree("probe-user", "probe-repo", big, {}));
	} catch (e) { error = e; }
	check("an oversized file is refused", error !== void 0, error?.message ?? "no error");
	check("the refusal names the file", /huge\.bin/.test(String(error?.message ?? "")), String(error?.message).slice(0, 90));
	check("no blob was uploaded before the refusal", !fake.calls.some((c) => c.path.endsWith("/git/blobs")));
	rmSync(big, { recursive: true, force: true });
}

/* --- 5e. an existing repo's description is refreshed on update ----------- */
/*
 * The manifest's description changes far more often than the repository is
 * recreated, and a stale line on the repository page is the visible half of
 * the plugin. This pins the PATCH.
 */
{
	const fake = fakeGitHub({ repoExists: true, description: "An old description." });
	const gh = new GitHub("fake-token");
	const made = await withFake(fake, () => gh.ensureRepo("probe-user", "probe-repo", "A new description."));
	check("the existing repo is not recreated", made.created === false);
	check("a changed description is patched", made.described === true, JSON.stringify(made));
	check("the description PATCH carries the new text",
		fake.calls.some((c) => c.method === "PATCH" && c.body?.description === "A new description."),
		JSON.stringify(fake.calls.filter((c) => c.method === "PATCH").map((c) => c.body)));
}

/* --- 5f. an unchanged description is not patched ------------------------- */
{
	const fake = fakeGitHub({ repoExists: true, description: "Same." });
	const gh = new GitHub("fake-token");
	const made = await withFake(fake, () => gh.ensureRepo("probe-user", "probe-repo", "Same."));
	check("an identical description is left alone", made.described === false, JSON.stringify(made));
	check("no PATCH is sent", !fake.calls.some((c) => c.method === "PATCH"));
}

/* --- 6. the retry wrapper ------------------------------------------------ */
{
	let attempts = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		attempts += 1;
		if (attempts < 3) {
			const error = new Error("fetch failed");
			error.cause = { code: "ECONNRESET" };
			throw error;
		}
		return new Response("ok");
	};
	try {
		const r = await resilientFetch("https://api.github.com/x");
		check("a reset is retried until it succeeds", attempts === 3 && (await r.text()) === "ok", `attempts=${attempts}`);
	} finally {
		globalThis.fetch = original;
	}

	attempts = 0;
	globalThis.fetch = async () => {
		attempts += 1;
		throw new Error("some permanent failure");
	};
	try {
		await resilientFetch("https://api.github.com/x");
		check("a non-transient error is not retried", false, "did not throw");
	} catch {
		check("a non-transient error is not retried", attempts === 1, `attempts=${attempts}`);
	} finally {
		globalThis.fetch = original;
	}
}

rmSync(dir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);